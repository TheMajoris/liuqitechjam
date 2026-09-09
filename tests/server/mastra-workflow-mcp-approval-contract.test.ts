import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { Mastra } from "@mastra/core";
import { InMemoryStore } from "@mastra/core/storage";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

type Counter = { calls: number };

const inputSchema = z.object({ value: z.string() });
const workflowOutputSchema = z.object({
  status: z.enum(["denied", "executed", "cancelled"]),
  value: z.string(),
  calls: z.number(),
});
const suspendSchema = z.object({ summary: z.string() });
const resumeSchema = z.object({ approved: z.boolean() });
type WorkflowOutput = z.infer<typeof workflowOutputSchema>;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

type PendingInvocation = {
  run: Awaited<ReturnType<ReturnType<typeof createWorkflow>['createRun']>>;
  value: string;
  completion: Deferred<WorkflowOutput>;
  closed: boolean;
  decisionClaimed: boolean;
};

type JsonRpcResponse = {
  jsonrpc: string;
  id: number;
  result?: {
    isError?: boolean;
    content?: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
  };
  error?: { code: number; message: string };
};

type HttpJsonResponse = {
  status: number;
  body: Record<string, unknown>;
};

function outputForCancellation(value: string, counter: Counter): WorkflowOutput {
  return { status: "cancelled", value, calls: counter.calls };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const payload = Buffer.concat(chunks).toString("utf8");
  return payload.length === 0 ? {} : JSON.parse(payload);
}

function sendJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (response.writableEnded || response.destroyed) return;
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

function resultOutput(result: unknown): WorkflowOutput {
  if (!result || typeof result !== "object" || !("result" in result)) {
    throw new Error("Mastra approval run did not return a result");
  }
  return workflowOutputSchema.parse((result as { result: unknown }).result);
}

function makeApprovalWorkflow(counter: Counter) {
  const approvalStep = createStep({
    id: "approval",
    inputSchema,
    outputSchema: workflowOutputSchema,
    suspendSchema,
    resumeSchema,
    execute: async ({ inputData, resumeData, suspend }) => {
      // A resumed step starts again. Only an absent decision suspends; false
      // is a terminal denial and must never reach the executor.
      if (resumeData === undefined) {
        return await suspend({ summary: "Approval is required" });
      }

      if (!resumeData.approved) {
        return { status: "denied" as const, value: inputData.value, calls: counter.calls };
      }

      counter.calls += 1;
      return { status: "executed" as const, value: inputData.value, calls: counter.calls };
    },
  });

  const workflow = createWorkflow({
    id: "http-approval-contract",
    description: "Bounded HTTP/MCP approval contract fixture",
    inputSchema,
    outputSchema: workflowOutputSchema,
    retryConfig: { attempts: 0, delay: 0 },
  })
    .then(approvalStep)
    .commit();

  const storage = new InMemoryStore({ id: "http-approval-contract-store" });
  new Mastra({
    logger: false,
    storage,
    workflows: { [workflow.id]: workflow },
  });

  return workflow;
}

class HttpApprovalFixture {
  readonly counter: Counter = { calls: 0 };
  readonly workflow = makeApprovalWorkflow(this.counter);
  readonly pending = new Map<string, PendingInvocation>();
  readonly baseUrl: string;

  private readonly server: Server;
  private readonly suspendedIds: string[] = [];
  private readonly suspensionWaiters: Array<(id: string) => void> = [];
  private readonly cancellationWaiters: Array<(id: string) => void> = [];
  private readonly cancelledIds: string[] = [];

  private constructor(server: Server, port: number) {
    this.server = server;
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  static async create(): Promise<HttpApprovalFixture> {
    let fixture!: HttpApprovalFixture;
    const server = createServer((request, response) => {
      void fixture.handle(request, response);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Fixture HTTP server did not expose an address");
    }
    fixture = new HttpApprovalFixture(server, (address as AddressInfo).port);
    return fixture;
  }

  async close(): Promise<void> {
    for (const id of [...this.pending.keys()]) {
      await this.cancelInvocation(id);
    }
    if (this.server.listening) {
      this.server.close();
      await once(this.server, "close");
    }
  }

  async waitForSuspended(): Promise<string> {
    const id = this.suspendedIds.shift();
    if (id !== undefined) return id;
    const signal = deferred<string>();
    this.suspensionWaiters.push(signal.resolve);
    return signal.promise;
  }

  async waitForCancellation(): Promise<string> {
    const id = this.cancelledIds.shift();
    if (id !== undefined) return id;
    const signal = deferred<string>();
    this.cancellationWaiters.push(signal.resolve);
    return signal.promise;
  }

  async callTool(id: number, value: string): Promise<{ response: Response; body: JsonRpcResponse }> {
    const response = await fetch(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "project.preview.restart", arguments: { value } },
      }),
    });
    return { response, body: (await response.json()) as JsonRpcResponse };
  }

  async decide(id: string, approved: boolean): Promise<HttpJsonResponse> {
    const response = await fetch(`${this.baseUrl}/control/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fixture-trusted-control": "trusted",
      },
      body: JSON.stringify({ approved }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  abortTool(id: number, value: string): { request: ReturnType<typeof httpRequest> } {
    const request = httpRequest(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
    });
    // Aborting the originating call intentionally emits an ECONNRESET on the
    // client side. The server-side close handler is the assertion target.
    request.on("error", () => undefined);
    request.end(JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "project.preview.restart", arguments: { value } },
    }));
    return { request };
  }

  private announceSuspended(id: string): void {
    const waiter = this.suspensionWaiters.shift();
    if (waiter) waiter(id);
    else this.suspendedIds.push(id);
  }

  private announceCancelled(id: string): void {
    const waiter = this.cancellationWaiters.shift();
    if (waiter) waiter(id);
    else this.cancelledIds.push(id);
  }

  private async startInvocation(value: string, onSuspended: (id: string) => void): Promise<WorkflowOutput> {
    const id = randomUUID();
    const run = await this.workflow.createRun({ runId: id });
    const started = await run.start({ inputData: { value } });
    if (started.status !== "suspended") {
      throw new Error(`Expected suspended approval run, got ${started.status}`);
    }

    const completion = deferred<WorkflowOutput>();
    this.pending.set(id, {
      run,
      value,
      completion,
      closed: false,
      decisionClaimed: false,
    });
    this.announceSuspended(id);
    onSuspended(id);
    try {
      return await completion.promise;
    } finally {
      this.pending.delete(id);
    }
  }

  private async approveInvocation(id: string, approved: boolean): Promise<WorkflowOutput> {
    const invocation = this.pending.get(id);
    if (!invocation || invocation.closed || invocation.decisionClaimed) {
      throw new Error("Approval is no longer pending");
    }
    invocation.decisionClaimed = true;
    try {
      const result = await invocation.run.resume({
        step: "approval",
        resumeData: { approved },
      });
      const output = resultOutput(result);
      invocation.completion.resolve(output);
      return output;
    } catch (error) {
      invocation.closed = true;
      invocation.completion.reject(error);
      throw error;
    }
  }

  private async cancelInvocation(id: string): Promise<void> {
    const invocation = this.pending.get(id);
    if (!invocation || invocation.closed) return;
    // Close the application fence before asking Mastra to persist cancellation.
    // A late control action therefore cannot claim or resume this invocation.
    invocation.closed = true;
    this.pending.delete(id);
    invocation.completion.resolve(outputForCancellation(invocation.value, this.counter));
    await invocation.run.cancel();
    this.announceCancelled(id);
  }

  private async handleControl(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    if (request.headers["x-fixture-trusted-control"] !== "trusted") {
      sendJson(response, 401, { error: "trusted control action required" });
      return;
    }
    const id = decodeURIComponent(path.slice("/control/".length));
    let payload: unknown;
    try {
      payload = await readJson(request);
    } catch {
      sendJson(response, 400, { error: "invalid decision" });
      return;
    }
    const decision = z.object({ approved: z.boolean() }).safeParse(payload);
    if (!decision.success) {
      sendJson(response, 400, { error: "invalid decision" });
      return;
    }
    try {
      const output = await this.approveInvocation(id, decision.data.approved);
      sendJson(response, 200, { ok: true, status: output.status });
    } catch {
      sendJson(response, 409, { error: "approval is closed" });
    }
  }

  private async handleMcp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let payload: unknown;
    try {
      payload = await readJson(request);
    } catch {
      sendJson(response, 400, { error: "invalid JSON" });
      return;
    }

    let invocationId: string | undefined;
    const onOriginatingCallClosed = () => {
      // A normal completed response has writableEnded=true. A close before
      // that point is the originating client socket loss/cancellation case.
      if (!response.writableEnded && invocationId !== undefined) {
        void this.cancelInvocation(invocationId);
      }
    };
    request.once("aborted", onOriginatingCallClosed);
    response.once("close", onOriginatingCallClosed);

    const server = new McpServer({ name: "http-approval-fixture", version: "1.0.0" });
    server.registerTool(
      "project.preview.restart",
      {
        title: "Preview restart",
        description: "Fixture sensitive tool",
        inputSchema,
        outputSchema: workflowOutputSchema,
      },
      async (input: unknown) => {
        const parsed = inputSchema.parse(input);
        invocationId = undefined;
        const output = await this.startInvocation(parsed.value, (id) => {
          // The id is server-owned and captured only for socket-loss fencing;
          // it is never accepted as an MCP argument.
          invocationId = id;
        });
        if (output.status === "denied") {
          return {
            isError: true,
            structuredContent: output as Record<string, unknown>,
            content: [{ type: "text", text: "APPROVAL_DENIED: Preview restart was not approved" }],
          };
        }
        if (output.status === "cancelled") {
          return {
            isError: true,
            structuredContent: output as Record<string, unknown>,
            content: [{ type: "text", text: "APPROVAL_CANCELLED: Preview restart was cancelled" }],
          };
        }
        return {
          structuredContent: output as Record<string, unknown>,
          content: [{ type: "text", text: JSON.stringify(output) }],
        };
      },
    );

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, payload);
    } catch {
      sendJson(response, 500, { error: "MCP request failed" });
    } finally {
      request.off("aborted", onOriginatingCallClosed);
      response.off("close", onOriginatingCallClosed);
      await server.close().catch(() => undefined);
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? "/", this.baseUrl).pathname;
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "method not allowed" });
      return;
    }
    if (path === "/mcp") {
      await this.handleMcp(request, response);
      return;
    }
    if (path.startsWith("/control/")) {
      await this.handleControl(request, response, path);
      return;
    }
    sendJson(response, 404, { error: "not found" });
  }
}

describe("Mastra workflow approval over the original MCP HTTP call", () => {
  it("holds tools/call pending, then delivers approval to the same request", async () => {
    const fixture = await HttpApprovalFixture.create();
    try {
      let originalSettled = false;
      const originalPromise = fixture.callTool(101, "restart").then((result) => {
        originalSettled = true;
        return result;
      });

      const approvalId = await fixture.waitForSuspended();
      expect(originalSettled).toBe(false);
      expect(fixture.counter.calls).toBe(0);

      await expect(fixture.decide(approvalId, true)).resolves.toMatchObject({
        status: 200,
        body: { ok: true, status: "executed" },
      });
      const final = await originalPromise;
      expect(final.response.status).toBe(200);
      expect(final.body).toMatchObject({
        jsonrpc: "2.0",
        id: 101,
        result: {
          structuredContent: { status: "executed", value: "restart", calls: 1 },
        },
      });
      expect(fixture.counter.calls).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it("delivers safe denial to the original request without executing", async () => {
    const fixture = await HttpApprovalFixture.create();
    try {
      const originalPromise = fixture.callTool(102, "restart");
      const approvalId = await fixture.waitForSuspended();
      expect(fixture.counter.calls).toBe(0);

      await expect(fixture.decide(approvalId, false)).resolves.toMatchObject({
        status: 200,
        body: { ok: true, status: "denied" },
      });
      const final = await originalPromise;
      expect(final.body).toMatchObject({
        jsonrpc: "2.0",
        id: 102,
        result: {
          isError: true,
          structuredContent: { status: "denied", calls: 0 },
          content: [{ text: "APPROVAL_DENIED: Preview restart was not approved" }],
        },
      });
      expect(fixture.counter.calls).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it("closes a lost originating socket and fences a late approval", async () => {
    const fixture = await HttpApprovalFixture.create();
    try {
      const originating = fixture.abortTool(103, "restart");
      const approvalId = await fixture.waitForSuspended();
      originating.request.destroy();

      await expect(fixture.waitForCancellation()).resolves.toBe(approvalId);
      expect(originating.request.destroyed).toBe(true);
      expect(fixture.counter.calls).toBe(0);

      await expect(fixture.decide(approvalId, true)).resolves.toMatchObject({
        status: 409,
        body: { error: "approval is closed" },
      });
      await expect(fixture.workflow.getWorkflowRunById(approvalId)).resolves.toMatchObject({
        status: "canceled",
      });
      expect(fixture.counter.calls).toBe(0);
    } finally {
      await fixture.close();
    }
  });
});
