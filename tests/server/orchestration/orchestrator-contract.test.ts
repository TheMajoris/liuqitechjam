import { LangGraphOrchestrator } from "../../../apps/server/src/orchestration/langgraph-orchestrator.js";
import { describeOrchestratorContract } from "./orchestrator-contract.js";

describeOrchestratorContract(
  "LangGraph",
  () => new LangGraphOrchestrator(),
);
