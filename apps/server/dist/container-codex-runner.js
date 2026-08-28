import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { buildCodexArgs, parseCodexEventLine } from "./codex-runner.js";
import { RunCancelledError } from "./errors.js";
const execFileAsync = promisify(execFile);
export function containerName(agentId, instanceId = "default") {
    const safeInstance = instanceId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 32);
    const safeAgent = agentId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48);
    return "launchpad-" + safeInstance + "-" + safeAgent;
}
export function buildContainerRunArgs(request, config) {
    const name = containerName(request.agentId, config.runtimeInstanceId);
    const engineName = config.containerEngine.split(/[\\/]/).at(-1)?.toLowerCase();
    return [
        "run",
        "--rm",
        "--init",
        "--name",
        name,
        "--label",
        "io.codejam.launchpad=agent-runtime",
        "--label",
        "io.codejam.agent-id=" + request.agentId,
        "--label",
        "io.codejam.instance-id=" + config.runtimeInstanceId,
        ...(engineName === "podman" ? ["--userns", "keep-id"] : []),
        "--network",
        "bridge",
        "--security-opt",
        "no-new-privileges",
        "--cap-drop",
        "ALL",
        "--cpus",
        String(config.containerCpuLimit),
        "--memory",
        config.containerMemoryLimit,
        "--pids-limit",
        String(config.containerPidsLimit),
        "--user",
        config.containerUser,
        "--env",
        "ARK_API_KEY",
        "--env",
        "CODEX_HOME=/codex-home",
        "--env",
        "HOME=/tmp",
        "--env",
        "NO_COLOR=1",
        "--mount",
        "type=bind,src=" + request.workspacePath + ",dst=/workspace",
        "--mount",
        "type=bind,src=" + config.codexHome + ",dst=/codex-home",
        "--workdir",
        "/workspace",
        config.containerRuntimeImage,
        "codex",
        ...buildCodexArgs(request, config.codexSandboxMode, "/workspace"),
    ];
}
export class ContainerCodexRunner {
    config;
    active = new Map();
    constructor(config) {
        this.config = config;
    }
    async isAvailable() {
        try {
            await execFileAsync(this.config.containerEngine, ["version"], {
                timeout: 5_000,
                env: this.childEnvironment(),
            });
            await execFileAsync(this.config.containerEngine, ["image", "inspect", this.config.containerRuntimeImage], { timeout: 5_000, env: this.childEnvironment() });
            return true;
        }
        catch {
            return false;
        }
    }
    async cancel(agentId) {
        const active = this.active.get(agentId);
        if (!active)
            return false;
        active.cancelled = true;
        await this.removeContainer(active);
        await active.settled;
        return true;
    }
    removeContainer(active) {
        if (!active.termination) {
            active.termination = execFileAsync(this.config.containerEngine, ["rm", "--force", active.containerName], { timeout: 8_000, env: this.childEnvironment() })
                .then(() => undefined)
                .catch(() => {
                active.child.kill("SIGTERM");
                const forceKill = setTimeout(() => active.child.kill("SIGKILL"), 3_000);
                forceKill.unref();
            });
        }
        return active.termination;
    }
    async run(request) {
        if (this.active.has(request.agentId)) {
            throw new Error("Agent already has an active Runtime container");
        }
        const child = spawn(this.config.containerEngine, buildContainerRunArgs(request, this.config), {
            cwd: request.workspacePath,
            env: this.childEnvironment(),
            stdio: ["ignore", "pipe", "pipe"],
        });
        const settled = new Promise((resolve) => {
            child.once("close", () => resolve());
            child.once("error", () => resolve());
        });
        const active = {
            child,
            containerName: containerName(request.agentId, this.config.runtimeInstanceId),
            cancelled: false,
            timedOut: false,
            outputExceeded: false,
            settled,
            termination: null,
        };
        this.active.set(request.agentId, active);
        const parsed = {
            messages: [],
            threadId: request.threadId,
            usage: null,
            errors: [],
        };
        let stdout = "";
        let stderr = "";
        let totalBytes = 0;
        const consume = (chunk, target) => {
            totalBytes += chunk.byteLength;
            if (totalBytes > this.config.codexMaxOutputBytes) {
                active.outputExceeded = true;
                void this.removeContainer(active);
                return;
            }
            if (target === "stdout") {
                stdout += chunk.toString("utf8");
                const lines = stdout.split(/\r?\n/);
                stdout = lines.pop() ?? "";
                for (const line of lines)
                    parseCodexEventLine(line, parsed);
            }
            else {
                stderr += chunk.toString("utf8");
                if (stderr.length > 16_384)
                    stderr = stderr.slice(-16_384);
            }
        };
        child.stdout.on("data", (chunk) => consume(chunk, "stdout"));
        child.stderr.on("data", (chunk) => consume(chunk, "stderr"));
        const timeout = setTimeout(() => {
            active.timedOut = true;
            void this.removeContainer(active);
        }, this.config.codexTimeoutMs);
        timeout.unref();
        try {
            const exitCode = await new Promise((resolve, reject) => {
                child.once("error", reject);
                child.once("close", (code) => resolve(code ?? 1));
            });
            if (stdout.trim())
                parseCodexEventLine(stdout.trim(), parsed);
            if (active.cancelled)
                throw new RunCancelledError();
            if (active.timedOut) {
                throw new Error("Runtime timed out after " + this.config.codexTimeoutMs + " ms");
            }
            if (active.outputExceeded) {
                throw new Error("Codex output exceeded CODEX_MAX_OUTPUT_BYTES");
            }
            if (exitCode !== 0) {
                const detail = parsed.errors.at(-1) ?? stderr.trim() ?? "No error detail";
                throw new Error(this.config.containerEngine +
                    " Runtime exited with code " +
                    exitCode +
                    ": " +
                    detail);
            }
            const output = parsed.messages.at(-1)?.trim();
            if (!output)
                throw new Error("Codex completed without an agent message");
            return { output, threadId: parsed.threadId, usage: parsed.usage };
        }
        finally {
            clearTimeout(timeout);
            this.active.delete(request.agentId);
        }
    }
    childEnvironment() {
        const environment = {
            ARK_API_KEY: this.config.arkApiKey,
            NO_COLOR: "1",
        };
        for (const name of [
            "PATH",
            "HOME",
            "TMPDIR",
            "LANG",
            "LC_ALL",
            "XDG_RUNTIME_DIR",
        ]) {
            if (process.env[name] !== undefined)
                environment[name] = process.env[name];
        }
        return environment;
    }
}
