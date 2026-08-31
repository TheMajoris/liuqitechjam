import { describeOrchestratorContract } from "../orchestrator-contract.js";
import { MastraOrchestrator } from "../../../../apps/server/src/orchestration/mastra/mastra-orchestrator.js";

describeOrchestratorContract(
  "Mastra",
  () => new MastraOrchestrator(),
);
