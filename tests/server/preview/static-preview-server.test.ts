import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const serverScript = fileURLToPath(
  new URL("../../../scripts/preview-static-server.mjs", import.meta.url),
);
const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function availablePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
  });
  const address = listener.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error("A test port could not be allocated");
  return port;
}

async function startServer(root: string, port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, [serverScript, root, String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Static preview server did not start")), 5_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("listening on 0.0.0.0:")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (code !== null || signal !== null) {
        clearTimeout(timer);
        reject(new Error("Static preview server exited before startup"));
      }
    });
  });
  return child;
}

describe("bundled static preview server", () => {
  it("serves exact files safely with fixed headers and no SPA fallback", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-static-preview-test-"));
    roots.push(root);
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "index.html"), "<!doctype html><h1>Static</h1>", "utf8");
    await writeFile(path.join(root, "assets", "app.js"), "console.log('ok');", "utf8");
    await writeFile(path.join(root, "assets", "app.css"), "body { color: red; }", "utf8");
    await writeFile(path.join(root, ".env"), "SECRET=hidden", "utf8");
    const outside = path.join(path.dirname(root), "launchpad-static-preview-secret.txt");
    await writeFile(outside, "outside", "utf8");
    await symlink(outside, path.join(root, "escape.txt"));
    roots.push(outside);

    const port = await availablePort();
    await startServer(root, port);

    const rootResponse = await fetch(`http://127.0.0.1:${port}/`);
    expect(rootResponse.status).toBe(200);
    expect(await rootResponse.text()).toContain("<h1>Static</h1>");
    expect(rootResponse.headers.get("content-type")).toContain("text/html");
    expect(rootResponse.headers.get("content-length")).toBe(String(Buffer.byteLength("<!doctype html><h1>Static</h1>")));
    expect(rootResponse.headers.get("cache-control")).toBe("no-cache");
    expect(rootResponse.headers.get("x-content-type-options")).toBe("nosniff");

    const assetResponse = await fetch(`http://127.0.0.1:${port}/assets/app.js`);
    expect(assetResponse.status).toBe(200);
    expect(await assetResponse.text()).toBe("console.log('ok');");
    expect(assetResponse.headers.get("content-type")).toContain("text/javascript");

    const headResponse = await fetch(`http://127.0.0.1:${port}/assets/app.css`, { method: "HEAD" });
    expect(headResponse.status).toBe(200);
    expect(await headResponse.text()).toBe("");
    expect(headResponse.headers.get("content-length")).toBe(String(Buffer.byteLength("body { color: red; }")));

    expect((await fetch(`http://127.0.0.1:${port}/settings`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/assets`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/.env`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/escape.txt`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/%2e%2e/launchpad-static-preview-secret.txt`)).status).toBeGreaterThanOrEqual(400);
    expect((await fetch(`http://127.0.0.1:${port}/assets/app.js`, { method: "POST" })).status).toBe(405);
  });
});
