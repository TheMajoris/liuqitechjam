import { randomUUID } from "node:crypto";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
const now = () => new Date().toISOString();
export class AgentService {
    config;
    store;
    workspaces;
    runner;
    activeExecutions = new Map();
    cancellationRequests = new Set();
    constructor(config, store, workspaces, runner) {
        this.config = config;
        this.store = store;
        this.workspaces = workspaces;
        this.runner = runner;
    }
    async initialize() {
        await this.store.initialize();
        await this.workspaces.initialize();
        await this.store.mutate((database) => {
            for (const run of database.runs) {
                if (run.status === "queued" || run.status === "running") {
                    run.status = "cancelled";
                    run.error = "Server restarted while this run was active";
                    run.completedAt = now();
                }
            }
            for (const agent of database.agents) {
                if (agent.status === "busy") {
                    agent.status = "ready";
                    agent.updatedAt = now();
                }
            }
        });
    }
    listAgents() {
        return this.store
            .snapshot()
            .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    }
    getAgent(id) {
        const agent = this.store.snapshot().agents.find((item) => item.id === id);
        if (!agent) {
            throw new HttpError(404, "Agent not found");
        }
        return agent;
    }
    async createAgent(input) {
        const timestamp = now();
        const id = randomUUID();
        const agent = {
            id,
            name: input.name.trim(),
            description: input.description?.trim() ?? "",
            instructions: input.instructions?.trim() ?? "",
            status: "ready",
            workspacePath: this.workspaces.workspacePath(id),
            codexThreadId: null,
            lastError: null,
            createdAt: timestamp,
            updatedAt: timestamp,
        };
        await this.workspaces.create(agent);
        await this.store.mutate((database) => database.agents.push(agent));
        return agent;
    }
    async updateAgent(id, input) {
        const current = this.getAgent(id);
        if (current.status === "busy") {
            throw new HttpError(409, "Stop the active run before editing this Agent");
        }
        const updated = await this.store.mutate((database) => {
            const agent = database.agents.find((item) => item.id === id);
            if (!agent) {
                throw new HttpError(404, "Agent not found");
            }
            if (agent.status === "busy") {
                throw new HttpError(409, "Stop the active run before editing this Agent");
            }
            if (input.name !== undefined)
                agent.name = input.name.trim();
            if (input.description !== undefined)
                agent.description = input.description.trim();
            if (input.instructions !== undefined)
                agent.instructions = input.instructions.trim();
            agent.lastError = null;
            agent.updatedAt = now();
            return structuredClone(agent);
        });
        await this.workspaces.writeInstructions(updated);
        return updated;
    }
    async deleteAgent(id) {
        const agent = this.getAgent(id);
        await this.cancelExecution(id);
        const archivedWorkspace = await this.workspaces.archive(agent);
        await this.store.mutate((database) => {
            database.agents = database.agents.filter((item) => item.id !== id);
            database.messages = database.messages.filter((item) => item.agentId !== id);
            database.runs = database.runs.filter((item) => item.agentId !== id);
        });
        return { archivedWorkspace };
    }
    async startAgent(id) {
        return this.setStatus(id, "ready");
    }
    async stopAgent(id) {
        this.getAgent(id);
        await this.cancelExecution(id);
        return this.setStatus(id, "stopped");
    }
    getMessages(agentId) {
        this.getAgent(agentId);
        return this.store
            .snapshot()
            .messages.filter((message) => message.agentId === agentId)
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    }
    getRun(runId) {
        const run = this.store.snapshot().runs.find((item) => item.id === runId);
        if (!run) {
            throw new HttpError(404, "Run not found");
        }
        return run;
    }
    getRuns(agentId) {
        this.getAgent(agentId);
        return this.store
            .snapshot()
            .runs.filter((run) => run.agentId === agentId)
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    }
    async sendMessage(agentId, prompt) {
        if (!isArkConfigured(this.config)) {
            throw new HttpError(503, "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.");
        }
        const timestamp = now();
        const runId = randomUUID();
        const run = {
            id: runId,
            agentId,
            status: "queued",
            prompt,
            output: null,
            error: null,
            usage: null,
            startedAt: null,
            completedAt: null,
            createdAt: timestamp,
        };
        const message = {
            id: randomUUID(),
            agentId,
            runId,
            role: "user",
            content: prompt,
            createdAt: timestamp,
        };
        const agentAtStart = await this.store.mutate((database) => {
            const storedAgent = database.agents.find((item) => item.id === agentId);
            if (!storedAgent) {
                throw new HttpError(404, "Agent not found");
            }
            if (storedAgent.status === "stopped") {
                throw new HttpError(409, "Start the Agent before sending a message");
            }
            if (storedAgent.status === "busy") {
                throw new HttpError(409, "This Agent is already running");
            }
            database.runs.push(run);
            database.messages.push(message);
            const snapshot = structuredClone(storedAgent);
            storedAgent.status = "busy";
            storedAgent.lastError = null;
            storedAgent.updatedAt = timestamp;
            return snapshot;
        });
        const execution = this.executeRun(agentAtStart, run);
        this.activeExecutions.set(agentId, execution);
        void execution
            .finally(() => {
            if (this.activeExecutions.get(agentId) === execution) {
                this.activeExecutions.delete(agentId);
            }
        })
            .catch(() => undefined);
        return { run, message };
    }
    async systemInfo() {
        return {
            arkConfigured: isArkConfigured(this.config),
            arkBaseUrl: this.config.arkBaseUrl,
            arkModel: this.config.arkModel || null,
            codexAvailable: await this.runner.isAvailable(),
            codexSandboxMode: this.config.codexSandboxMode,
            runtimeProvider: this.config.runtimeProvider,
            containerEngine: this.config.runtimeProvider === "container"
                ? this.config.containerEngine
                : null,
            runtime: this.config.runtimeProvider === "container"
                ? "Codex CLI in " + this.config.containerEngine + " Runtime"
                : "Codex CLI in application container",
        };
    }
    async executeRun(agentAtStart, run) {
        await this.store.mutate((database) => {
            const storedRun = database.runs.find((item) => item.id === run.id);
            if (storedRun) {
                storedRun.status = "running";
                storedRun.startedAt = now();
            }
        });
        try {
            if (this.cancellationRequests.has(agentAtStart.id)) {
                throw new RunCancelledError();
            }
            const result = await this.runner.run({
                agentId: agentAtStart.id,
                workspacePath: agentAtStart.workspacePath,
                prompt: run.prompt,
                threadId: agentAtStart.codexThreadId,
            });
            const completedAt = now();
            await this.store.mutate((database) => {
                const storedRun = database.runs.find((item) => item.id === run.id);
                const agent = database.agents.find((item) => item.id === agentAtStart.id);
                if (!storedRun || !agent)
                    return;
                storedRun.status = "completed";
                storedRun.output = result.output;
                storedRun.usage = result.usage;
                storedRun.completedAt = completedAt;
                database.messages.push({
                    id: randomUUID(),
                    agentId: agent.id,
                    runId: run.id,
                    role: "assistant",
                    content: result.output,
                    createdAt: completedAt,
                });
                agent.status = "ready";
                agent.codexThreadId = result.threadId;
                agent.lastError = null;
                agent.updatedAt = completedAt;
            });
        }
        catch (error) {
            const completedAt = now();
            const cancelled = error instanceof RunCancelledError;
            const message = error instanceof Error ? error.message : String(error);
            await this.store.mutate((database) => {
                const storedRun = database.runs.find((item) => item.id === run.id);
                const agent = database.agents.find((item) => item.id === agentAtStart.id);
                if (storedRun) {
                    storedRun.status = cancelled ? "cancelled" : "failed";
                    storedRun.error = message;
                    storedRun.completedAt = completedAt;
                }
                if (agent) {
                    if (agent.status !== "stopped") {
                        agent.status = cancelled ? "ready" : "error";
                    }
                    agent.lastError = cancelled ? null : message;
                    agent.updatedAt = completedAt;
                }
            });
        }
    }
    async setStatus(id, status) {
        return this.store.mutate((database) => {
            const agent = database.agents.find((item) => item.id === id);
            if (!agent) {
                throw new HttpError(404, "Agent not found");
            }
            if (status === "ready" && agent.status === "busy") {
                throw new HttpError(409, "Stop the active run before starting this Agent");
            }
            agent.status = status;
            if (status === "ready")
                agent.lastError = null;
            agent.updatedAt = now();
            return structuredClone(agent);
        });
    }
    async cancelExecution(agentId) {
        this.cancellationRequests.add(agentId);
        try {
            await this.runner.cancel(agentId);
            const execution = this.activeExecutions.get(agentId);
            if (execution) {
                await execution;
            }
        }
        finally {
            this.cancellationRequests.delete(agentId);
        }
    }
}
