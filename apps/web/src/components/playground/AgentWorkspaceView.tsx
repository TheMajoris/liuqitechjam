import { useEffect, useRef } from "react";
import type { Agent, SkillMetadata, SystemInfo } from "../../types";
import { MarkdownMessage } from "../MarkdownMessage";
import { PreviewSidecar } from "../PreviewSidecar";
import { StickyComposer } from "../StickyComposer";
import { formatReasoningEffort, formatWorkerModelRef } from "../WorkerModelFields";
import type { AgentForm } from "../../playground/agent-form";
import type { ModelCatalogController } from "../../playground/use-model-catalog";
import type { AgentWorkspaceController } from "../../playground/use-agent-workspace";
import { AgentSettingsPanel } from "./AgentSettingsPanel";
import { Spinner } from "./Spinner";

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
  skillCatalog: SkillMetadata[];
  skillLoading: boolean;
  skillError: string | null;
  form: AgentForm;
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
  skillCatalog,
  skillLoading,
  skillError,
  form,
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
  const openConversation = controller.conversations.find(
    (conversation) => conversation.id === controller.conversationId,
  );
  const agentModels = agent.modelRef?.providerId
    ? modelCatalog.modelsByProvider[agent.modelRef.providerId] ?? []
    : [];

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [controller.messages, controller.activeRun]);

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
        {showSettings && (
          <AgentSettingsPanel
            agent={agent}
            form={form}
            modelCatalog={modelCatalog}
            skillCatalog={skillCatalog}
            skillLoading={skillLoading}
            skillError={skillError}
            assignedSkills={controller.agentSkills}
            disabled={busy}
            skillsDisabled={busy || agent.status === "busy"}
            invalidModel={modelCatalog.modelSelectionInvalid}
            onChange={onFormChange}
            onSubmit={onSave}
            onClose={onCloseSettings}
          />
        )}
        <section className="conversation-pane" aria-label="Conversation">
          <div className="playground-topbar">
            <div>
              <span className="eyebrow">Agent workspace</span>
              <h2>{openConversation?.title ?? "New conversation"}</h2>
            </div>
            <div className="session-info">
              <span className="pulse" />
              {/* Session continuity is per conversation, never per Agent. */}
              {openConversation?.codexThreadId ? "Session connected" : "New session"}
            </div>
          </div>

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
                <span>{controller.activeRun.error}</span>
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
