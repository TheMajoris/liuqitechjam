import { LangGraphOrchestrator } from "../langgraph-orchestrator.js";
import { describeOrchestratorContract } from "./orchestrator-contract.js";

describeOrchestratorContract(
  "LangGraph",
  () => new LangGraphOrchestrator(),
);
