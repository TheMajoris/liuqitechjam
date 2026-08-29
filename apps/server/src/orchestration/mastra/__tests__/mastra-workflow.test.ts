import { describeOrchestratorContract } from "../../__tests__/orchestrator-contract.js";
import { MastraOrchestrator } from "../mastra-orchestrator.js";

describeOrchestratorContract(
  "Mastra",
  () => new MastraOrchestrator(),
);
