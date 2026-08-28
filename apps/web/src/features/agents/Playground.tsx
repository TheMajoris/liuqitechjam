import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import type { Agent, Message, Run, SystemInfo } from "../../api/contracts";
import { Spinner } from "../../shared/ui/states";
import { formatTime } from "../../shared/utils/format";

const STARTER_PROMPTS = [
  "Inspect this workspace and explain what you would improve first.",
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Add a test for the most important untested function you can find.",
];

const isPending = (run: Run | null): boolean =>
  run != null && (run.status === "queued" || run.status === "running");

/**
 * The baseline Agent Playground, moved into the agents feature unchanged in
 * behaviour: send a prompt, poll the resulting run, then show the messages.
 */
export function Playground({
  agent,
  system,
  onRunSettled,
}: {
  agent: Agent;
  system: SystemInfo | null;
  onRunSettled: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeRun, setActiveRun] = useState<Run | null>(null);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const endRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const agentIdRef = useRef(agent.id);
  agentIdRef.current = agent.id;
  const pollingRef = useRef(new Set<string>());

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.agentMessages(agentId);
    if (mountedRef.current && agentIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const pollRun = useCallback(
    async (runId: string, agentId: string) => {
      if (pollingRef.current.has(runId)) return;
      pollingRef.current.add(runId);
      try {
        while (mountedRef.current) {
          await new Promise((resolve) => window.setTimeout(resolve, 900));
          if (!mountedRef.current) return;
          const { run } = await api.getRun(runId);
          if (agentIdRef.current === agentId) setActiveRun(run);
          if (run.status !== "queued" && run.status !== "running") {
            await refreshMessages(agentId);
            onRunSettled();
            return;
          }
        }
      } catch (reason) {
        if (mountedRef.current) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      } finally {
        pollingRef.current.delete(runId);
      }
    },
    [refreshMessages, onRunSettled],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const agentId = agent.id;
    setLoading(true);
    setActiveRun(null);
    setMessages([]);
    setError(null);
    void Promise.all([api.agentMessages(agentId), api.agentRuns(agentId)])
      .then(([messageResult, runResult]) => {
        if (agentIdRef.current !== agentId) return;
        setMessages(messageResult.messages);
        const latest = runResult.runs[0] ?? null;
        setActiveRun(latest);
        if (isPending(latest)) void pollRun(latest!.id, agentId);
      })
      .catch((reason) => {
        if (agentIdRef.current === agentId) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (agentIdRef.current === agentId) setLoading(false);
      });
  }, [agent.id, pollRun]);

  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    endRef.current?.scrollIntoView({
      behavior: reduce ? "auto" : "smooth",
      block: "end",
    });
  }, [messages, activeRun]);

  const disabled =
    agent.status === "stopped" ||
    agent.status === "busy" ||
    isPending(activeRun);

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    const content = prompt.trim();
    if (!content || disabled) return;
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(agent.id, content);
      if (agentIdRef.current === agent.id) {
        setMessages((prev) => [...prev, result.message]);
        setActiveRun(result.run);
      }
      onRunSettled();
      await pollRun(result.run.id, agent.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
    }
  };

  return (
    <section className="panel playground" aria-label="Playground">
      <div className="panel-head-row">
        <div>
          <span className="panel-eyebrow">Playground</span>
          <h2>Build something with {agent.name}</h2>
        </div>
        <span className="session-chip">
          <span className="session-dot" aria-hidden="true" />
          {agent.codexThreadId ? "Session connected" : "New session"}
        </span>
      </div>

      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="messages" aria-live="polite" aria-busy={loading}>
        {loading ? (
          <div className="messages-loading">
            <Spinner label="Loading conversation" />
          </div>
        ) : messages.length === 0 && !activeRun ? (
          <div className="welcome">
            <h3>What should {agent.name} build?</h3>
            <p>
              The agent can inspect files, write code, run commands, and continue
              the same Codex session across messages.
            </p>
            <div className="prompt-grid">
              {STARTER_PROMPTS.map((item) => (
                <button
                  type="button"
                  key={item}
                  onClick={() => setPrompt(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <article
              className={`message message-${message.role}`}
              key={message.id}
            >
              <div className="message-meta">
                <strong>
                  {message.role === "user" ? "You" : agent.name}
                </strong>
                <span>{formatTime(message.createdAt)}</span>
              </div>
              <div className="message-body">{message.content}</div>
            </article>
          ))
        )}

        {isPending(activeRun) ? (
          <article className="message message-assistant is-thinking">
            <div className="message-meta">
              <strong>{agent.name}</strong>
              <span>working in the workspace</span>
            </div>
            <div className="thinking-row">
              <Spinner label="Working" />
              Codex is reading, editing, or running commands…
            </div>
          </article>
        ) : null}

        {activeRun?.status === "failed" ? (
          <article className="run-error" role="alert">
            <strong>Run failed</strong>
            <span>{activeRun.error ?? "The run ended with an error."}</span>
          </article>
        ) : null}

        <div ref={endRef} />
      </div>

      <form className="composer" onSubmit={send}>
        <label className="sr-only" htmlFor="playground-input">
          Message for {agent.name}
        </label>
        <textarea
          id="playground-input"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          rows={3}
          placeholder={
            agent.status === "stopped"
              ? "Start this agent to continue…"
              : "Describe what you want the agent to do…"
          }
          disabled={disabled}
        />
        <div className="composer-footer">
          <span>
            Enter to send · Shift + Enter for a newline ·{" "}
            {system?.codexSandboxMode ?? "sandbox pending"}
          </span>
          <button
            type="submit"
            className="button button-primary"
            disabled={disabled || prompt.trim() === ""}
          >
            Send
          </button>
        </div>
      </form>
    </section>
  );
}
