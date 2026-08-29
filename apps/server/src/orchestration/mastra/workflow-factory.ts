import { createWorkflow } from "@mastra/core/workflows";
import {
  createMastraOrchestrationStep,
  mastraExecutionStateSchema,
} from "./agent-step.js";
import type {
  MastraExecutionState,
  MastraOrchestrationStepOptions,
} from "./types.js";

export interface MastraOrchestrationWorkflowOptions
  extends MastraOrchestrationStepOptions {
  /** Stable per-orchestration workflow identifier. */
  id: string;
}

/**
 * Build one transient Mastra workflow for an entire orchestration.
 *
 * The generic state step performs exactly one participant turn. Mastra owns
 * the progression with `dowhile`; the step only returns the next serializable
 * state and the loop stops once that state is terminal.
 */
export function createMastraOrchestrationWorkflow(
  options: MastraOrchestrationWorkflowOptions,
) {
  const turnStep = createMastraOrchestrationStep({
    id: `${options.id}-turn`,
    invoker: options.invoker,
    perAgentTimeoutMs: options.perAgentTimeoutMs,
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    ...(options.supervisorTimeoutMs === undefined
      ? {}
      : { supervisorTimeoutMs: options.supervisorTimeoutMs }),
    ...(options.participantProfiles === undefined
      ? {}
      : { participantProfiles: options.participantProfiles }),
    ...(options.handoffLimits === undefined
      ? {}
      : { handoffLimits: options.handoffLimits }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    ...(options.onStepFailure === undefined
      ? {}
      : { onStepFailure: options.onStepFailure }),
    selectNextParticipant: options.selectNextParticipant,
  });

  return createWorkflow({
    id: options.id,
    inputSchema: mastraExecutionStateSchema,
    outputSchema: mastraExecutionStateSchema,
    // Platform-agent dispatch is a side effect; never replay it implicitly.
    retryConfig: { attempts: 0, delay: 0 },
    // This adapter is transient. Durable snapshots require a deliberate
    // storage decision and are intentionally outside this wave.
    options: { shouldPersistSnapshot: () => false },
  })
    .dowhile(
      turnStep,
      async ({ inputData }: { inputData: MastraExecutionState }) =>
        inputData.status === "running",
    )
    .commit();
}
