import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import { ContainerCodexRunner } from "./container-codex-runner.js";
import { CodexRunner } from "./codex-runner.js";
import { ContainerHealthSampler } from "./telemetry/container-health-sampler.js";
import type { AgentRunner } from "./types.js";

const execFileAsync = promisify(execFile);

export interface RunnerFactoryResult {
  runner: AgentRunner;
  /** Only set for the container runtime provider. */
  healthSampler?: ContainerHealthSampler;
}

export function createRunner(config: AppConfig): RunnerFactoryResult {
  if (config.runtimeProvider !== "container") {
    return { runner: new CodexRunner(config) };
  }
  const healthSampler = new ContainerHealthSampler({
    execEngine: (args, timeoutMs) =>
      execFileAsync(config.containerEngine, args, { timeout: timeoutMs }),
  });
  const runner = new ContainerCodexRunner(config, { healthSampler });
  return { runner, healthSampler };
}
