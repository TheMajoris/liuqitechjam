import { AnimatePresence } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type {
  Agent,
  AgentRole,
  ModelResourceSnapshot,
  SkillMetadata,
  SystemInfo,
} from "../../types";
import { MarkdownMessage } from "../MarkdownMessage";
import { RunListView } from "../trace/RunListView";
import { TraceDetailView } from "../trace/TraceDetailView";
import { PreviewSidecar } from "../PreviewSidecar";
import { StickyComposer } from "../StickyComposer";
import { formatReasoningEffort, formatWorkerModelRef } from "../WorkerModelFields";
import type { AgentForm } from "../../playground/agent-form";
import type { ModelCatalogController } from "../../playground/use-model-catalog";
import type { AgentWorkspaceController } from "../../playground/use-agent-workspace";
import { AgentSettingsPanel } from "./AgentSettingsPanel";
import { Spinner } from "./Spinner";
import { humanizeAgentRunFailure } from "../orchestration/orchestration-utils";

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

interface AgentWorkspaceViewProps {
  agent: Agent;
  system: SystemInfo | null;
  controller: AgentWorkspaceController;
  modelCatalog: ModelCatalogController;
  /** Live endpoint telemetry keyed `providerId:modelId`; annotates options. */
  modelResources?: Map<string, ModelResourceSnapshot>;
  skillCatalog: SkillMetadata[];
  skillLoading: boolean;
  skillError: string | null;
  form: AgentForm;
  roles?: AgentRole[];
  showSettings: boolean;
  previewPanelOpen: boolean;
  busy: boolean;
  onFormChange: (changes: Partial<AgentForm>) => void;
  onSave: (event: React.FormEvent) => void;
  onCloseSettings: () => void;
  onToggleSettings: () => void;
  onTogglePreviewPanel: () => void;
  onToggleAgent: () => void;
  onDeleteAgent: () => void;
}

/** Composition module for one selected Agent's private workspace. */
export function AgentWorkspaceView({
  agent,
  system,
  controller,
  modelCatalog,
  modelResources,
  skillCatalog,
  skillLoading,
  skillError,
  form,
  roles = [],
  showSettings,
  previewPanelOpen,
  busy,
  onFormChange,
  onSave,
  onCloseSettings,
  onToggleSettings,
  onTogglePreviewPanel,
  onToggleAgent,
  onDeleteAgent,
}: AgentWorkspaceViewProps) {
  const messageEnd = useRef<HTMLDivElement>(null);
  // Which side of the Agent this pane shows: the live conversation, or the
  // Agent's historical Runs and their evidence.
  const [tab, setTab] = useState<"conversation" | "runs">("conversation");
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const openConversation = controller.conversations.find(
    (conversation) => conversation.id === controller.conversationId,
  );
  const agentModels = agent.modelRef?.providerId
    ? modelCatalog.modelsByProvider[agent.modelRef.providerId] ?? []
    : [];

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [controller.messages, controller.activeRun]);

  useEffect(() => {
    setTab("conversation");
    setOpenRunId(null);
  }, [agent.id]);

  return (
    <div className="agent-workspace">
      <header className="agent-header">
        <div>
          <div className="header-title-row">
            <h1>{agent.name}</h1>
            <StatusPill status={agent.status} />
          </div>
          <p>{agent.description || "A Codex coding Agent in an isolated workspace."}</p>
          <div className="agent-header-model">
            <span className="eyebrow">Worker model</span>
            <strong>{formatWorkerModelRef(agent.modelRef, modelCatalog.providers, agentModels)}</strong>
            {modelCatalog.selectedAgentReasoningSupported && (
              <span>Reasoning: {formatReasoningEffort(modelCatalog.selectedAgentReasoning)}</span>
            )}
            <span>
              Fallbacks: {agent.fallbackModelRefs?.length ?? 0} configured
            </span>
          </div>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className={"button button-ghost preview-toggle " + (previewPanelOpen ? "is-active" : "")}
            onClick={onTogglePreviewPanel}
            aria-pressed={previewPanelOpen}
          >
            <span
              className={"preview-toggle-dot preview-dot-" +
                (controller.preview?.status ?? "not_started")}
              aria-hidden="true"
            />
            Preview
          </button>
          <button
            className="button button-ghost"
            onClick={onToggleSettings}
            disabled={busy || agent.status === "busy"}
          >
            Settings
          </button>
          <button className="button button-ghost" onClick={onToggleAgent} disabled={busy}>
            {agent.status === "stopped" ? "Start" : "Stop"}
          </button>
          <button
            className="button button-danger"
            onClick={onDeleteAgent}
            disabled={busy || agent.status === "busy"}
          >
            Delete
          </button>
        </div>
      </header>

      <div className="workspace-body">
        <AnimatePresence>
          {showSettings && (
            <AgentSettingsPanel
              agent={agent}
              form={form}
              modelCatalog={modelCatalog}
              {...(modelResources === undefined ? {} : { modelResources })}
              skillCatalog={skillCatalog}
              skillLoading={skillLoading}
              skillError={skillError}
              assignedSkills={controller.agentSkills}
              disabled={busy}
              skillsDisabled={busy || agent.status === "busy"}
              invalidModel={modelCatalog.modelSelectionInvalid}
              roles={roles}
              onChange={onFormChange}
              onSubmit={onSave}
              onClose={onCloseSettings}
            />
          )}
        </AnimatePresence>
        <section
          className="conversation-pane"
          aria-label={tab === "runs" ? "Runs" : "Conversation"}
        >
          <div className="playground-topbar">
            <div>
              <span className="eyebrow">Agent workspace</span>
              <h2>{tab === "runs" ? "Runs" : openConversation?.title ?? "New conversation"}</h2>
            </div>
            <div className="agent-pane-tabs" role="group" aria-label="Agent workspace view">
              <button
                type="button"
                className={"button" + (tab === "conversation" ? " is-active" : "")}
                aria-pressed={tab === "conversation"}
                onClick={() => setTab("conversation")}
              >
                Conversation
              </button>
              <button
                type="button"
                className={"button" + (tab === "runs" ? " is-active" : "")}
                aria-pressed={tab === "runs"}
                onClick={() => setTab("runs")}
              >
                Runs
              </button>
            </div>
            {tab === "conversation" && (
              <div className="session-info">
                <span className="pulse" />
                {/* Session continuity is per conversation, never per Agent. */}
                {openConversation?.codexThreadId ? "Session connected" : "New session"}
              </div>
            )}
          </div>

          {tab === "runs" ? (
            // The Agent-centric path: Agent → Runs → Run detail → trace/audit,
            // rendered by the same detail view the global explorer uses.
            openRunId === null ? (
              <div className="agent-runs-pane">
                <RunListView
                  agentId={agent.id}
                  hideAgent
                  onOpenRun={setOpenRunId}
                  emptyMessage={"No runs recorded for " + agent.name + " yet."}
                />
              </div>
            ) : (
              <div className="agent-runs-pane">
                <TraceDetailView
                  runId={openRunId}
                  backLabel="Back to runs"
                  onBack={() => setOpenRunId(null)}
                />
              </div>
            )
          ) : (
            <>
              <div className="messages">
                {controller.messages.length === 0 && !controller.activeRun ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>What should {agent.name} build?</h3>
                    <p>
                      The Agent can inspect files, write code, run commands, and continue the same
                      Codex session across messages.
                    </p>
                    <div className="prompt-grid">
                      {starterPrompts.map((item) => (
                        <button key={item} onClick={() => controller.setPrompt(item)}>
                          <span>↗</span>
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  controller.messages.map((message) => (
                    <article className={"message message-" + message.role} key={message.id}>
                      <div className="message-meta">
                        <strong>{message.role === "user" ? "You" : agent.name}</strong>
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      {message.role === "assistant" ? (
                        <MarkdownMessage className="message-body" content={message.content} />
                      ) : (
                        <div className="message-body">{message.content}</div>
                      )}
                    </article>
                  ))
                )}
                {controller.activeRun &&
                  (controller.activeRun.status === "queued" ||
                    controller.activeRun.status === "running") && (
                    <article className="message message-assistant thinking">
                      <div className="message-meta">
                        <strong>{agent.name}</strong>
                        <span>working in the Agent workspace</span>
                      </div>
                      <div className="thinking-row">
                        <Spinner />
                        Codex is reading, editing, or running commands…
                      </div>
                    </article>
                  )}
                {controller.activeRun?.status === "failed" && (
                  <article className="run-error">
                    <strong>Run failed</strong>
                    <span>
                      {humanizeAgentRunFailure(
                        controller.activeRun.errorCode,
                        controller.activeRun.error,
                      )}
                    </span>
                  </article>
                )}
                <div ref={messageEnd} />
              </div>

              <StickyComposer
                value={controller.prompt}
                placeholder={
                  agent.status === "stopped"
                    ? "Start this Agent to continue…"
                    : "Describe what you want the Agent to do…"
                }
                hint={
                  "Enter to send · Shift + Enter for newline · " +
                  (system?.codexSandboxMode ?? "checking sandbox")
                }
                disabled={agent.status === "stopped" || agent.status === "busy"}
                sending={controller.runInFlight}
                onChange={controller.setPrompt}
                onSubmit={controller.sendMessage}
              />
            </>
          )}
        </section>

        <PreviewSidecar
          open={previewPanelOpen}
          preview={controller.preview}
          logs={controller.previewLogs}
          busy={controller.previewBusy}
          actionError={controller.previewActionError}
          onClose={onTogglePreviewPanel}
          onStart={() => void controller.runPreviewAction("start")}
          onRestart={() => void controller.runPreviewAction("restart")}
          onStop={() => void controller.runPreviewAction("stop")}
          onOpenExternal={controller.openPreview}
        />

        {!previewPanelOpen && (
          <button
            type="button"
            className="preview-rail"
            onClick={onTogglePreviewPanel}
            aria-label="Show preview panel"
            aria-expanded={false}
            title="Show preview"
          >
            <span aria-hidden="true" className="preview-rail-arrow">‹</span>
            <span
              className={"preview-toggle-dot preview-dot-" +
                (controller.preview?.status ?? "not_started")}
              aria-hidden="true"
            />
          </button>
        )}
      </div>
    </div>
  );
}
