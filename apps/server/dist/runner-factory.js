import { ContainerCodexRunner } from "./container-codex-runner.js";
import { CodexRunner } from "./codex-runner.js";
export function createRunner(config) {
    return config.runtimeProvider === "container"
        ? new ContainerCodexRunner(config)
        : new CodexRunner(config);
}
