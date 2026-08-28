import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GatewayClientError,
  type GatewayManagementClient,
  type IssueLeaseRequest,
  type IssuedLease,
} from "../modules/model-access/gateway-client.js";
import { GatewayModelAccess } from "../modules/model-access/model-access.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../types.js";
import { SecretlessRunner } from "./secretless-runner.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

const makeRoot = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "secretless-runner-"));
  tempDirs.push(dir);
  return dir;
};

class FakeGateway implements GatewayManagementClient {
  revoked: string[] = [];
  issue: (r: IssueLeaseRequest) => Promise<IssuedLease> = async () => ({
    leaseId: "lease-1",
    token: "glease_opaque_run_lease",
    expiresAt: "2026-01-01T00:15:00.000Z",
  });
  async issueLease(request: IssueLeaseRequest): Promise<IssuedLease> {
    return this.issue(request);
  }
  async revokeLease(leaseId: string): Promise<void> {
    this.revoked.push(leaseId);
  }
}

const baseRequest: RunnerRequest = {
  agentId: "agent-1",
  workspacePath: "/tmp/workspace",
  prompt: "build the thing",
  threadId: null,
  runId: "run-1",
};

const makeInner = (
  impl: (request: RunnerRequest) => Promise<RunnerResult>,
): AgentRunner & { calls: RunnerRequest[] } => {
  const calls: RunnerRequest[] = [];
  return {
    calls,
    async run(request) {
      calls.push(request);
      return impl(request);
    },
    async cancel() {
      return true;
    },
    async isAvailable() {
      return true;
    },
  };
};

describe("SecretlessRunner", () => {
  it("leases, wires the inner runner to the gateway, then revokes and cleans up", async () => {
    const root = await makeRoot();
    const gateway = new FakeGateway();
    const modelAccess = new GatewayModelAccess({
      client: gateway,
      gatewayUrl: "http://gateway:4000",
    });
    let codexHomeDuringRun = "";
    const inner = makeInner(async (request) => {
      // The inner runner sees only the lease + gateway coordinates.
      expect(request.gateway).toEqual({
        gatewayUrl: "http://gateway:4000",
        leaseToken: "glease_opaque_run_lease",
        providerId: "ark",
        model: "ep-live",
        codexHome: path.join(root, "runs", "run-1"),
      });
      expect(JSON.stringify(request)).not.toMatch(/api[_-]?key/i);
      codexHomeDuringRun = request.gateway!.codexHome;
      const toml = await readFile(
        path.join(codexHomeDuringRun, "config.toml"),
        "utf8",
      );
      expect(toml).toContain('env_key = "MODEL_GATEWAY_TOKEN"');
      expect(toml).toContain("http://gateway:4000/p/ark/v1");
      expect(toml).not.toContain("ARK_API_KEY");
      return { output: "done", threadId: "thread-9", usage: null };
    });

    const runner = new SecretlessRunner({
      inner,
      modelAccess,
      providerId: "ark",
      model: "ep-live",
      gatewayUrl: "http://gateway:4000",
      codexHomeRoot: root,
    });

    const result = await runner.run(baseRequest);
    expect(result.output).toBe("done");
    expect(gateway.revoked).toEqual(["lease-1"]);
    // run-scoped Codex home is removed afterwards
    await expect(stat(codexHomeDuringRun)).rejects.toThrow();
  });

  it("fails closed without starting the inner runner when no lease can be issued", async () => {
    const root = await makeRoot();
    const gateway = new FakeGateway();
    gateway.issue = async () => {
      throw new GatewayClientError("GATEWAY_UNAVAILABLE", "gateway down");
    };
    const modelAccess = new GatewayModelAccess({
      client: gateway,
      gatewayUrl: "http://gateway:4000",
    });
    const inner = makeInner(async () => {
      throw new Error("inner runner must not start");
    });
    const runner = new SecretlessRunner({
      inner,
      modelAccess,
      providerId: "ark",
      model: "ep-live",
      gatewayUrl: "http://gateway:4000",
      codexHomeRoot: root,
    });

    await expect(runner.run(baseRequest)).rejects.toMatchObject({
      code: "GATEWAY_UNAVAILABLE",
    });
    expect(inner.calls).toHaveLength(0);
    await expect(stat(path.join(root, "runs", "run-1"))).rejects.toThrow();
  });

  it("revokes the lease and cleans up when the inner runner throws", async () => {
    const root = await makeRoot();
    const gateway = new FakeGateway();
    const modelAccess = new GatewayModelAccess({
      client: gateway,
      gatewayUrl: "http://gateway:4000",
    });
    const inner = makeInner(async () => {
      throw new Error("runtime blew up");
    });
    const runner = new SecretlessRunner({
      inner,
      modelAccess,
      providerId: "ark",
      model: "ep-live",
      gatewayUrl: "http://gateway:4000",
      codexHomeRoot: root,
    });

    await expect(runner.run(baseRequest)).rejects.toThrow("runtime blew up");
    expect(gateway.revoked).toEqual(["lease-1"]);
    await expect(stat(path.join(root, "runs", "run-1"))).rejects.toThrow();
  });
});
