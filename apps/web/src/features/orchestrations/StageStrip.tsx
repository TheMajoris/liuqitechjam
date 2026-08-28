import type { OrchestrationStage, StageState } from "../../api/contracts";
import { toneForStatus } from "../../shared/ui/StatusPill";

const FIXED_ORDER: readonly OrchestrationStage[] = [
  "planner",
  "builder",
  "reviewer",
];

const STAGE_LABEL: Record<OrchestrationStage, string> = {
  planner: "Planner",
  builder: "Builder",
  reviewer: "Reviewer",
};

/**
 * Fixed Planner → Builder → Reviewer strip. Renders backend `stages[]` only —
 * a missing stage shows as pending; nothing here is inferred or optimistic.
 */
export function StageStrip({ stages }: { stages: StageState[] }) {
  const byStage = new Map(stages.map((s) => [s.stage, s]));

  return (
    <ol className="stage-strip" aria-label="Pipeline stages">
      {FIXED_ORDER.map((stage, index) => {
        const state = byStage.get(stage);
        const status = state?.status ?? "pending";
        const tone = toneForStatus(status);
        return (
          <li key={stage} className={`stage-node tone-${tone}`}>
            <span className="stage-index" aria-hidden="true">
              {index + 1}
            </span>
            <span className="stage-body">
              <span className="stage-name">{STAGE_LABEL[stage]}</span>
              <span className="stage-status">{status}</span>
              {state && state.attempt > 1 ? (
                <span className="stage-retry" title="Retry attempts">
                  attempt {state.attempt}
                </span>
              ) : null}
              {state?.error ? (
                <span className="stage-error">{state.error}</span>
              ) : null}
            </span>
            {index < FIXED_ORDER.length - 1 ? (
              <span className="stage-arrow" aria-hidden="true">
                →
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
