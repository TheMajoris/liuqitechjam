#!/usr/bin/env node

import { createServer } from "node:http";
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);

function failStartup() {
  console.error("[preview-static] failed to start");
  process.exitCode = 1;
}

if (args.length !== 2) {
  failStartup();
} else {
  const [workspaceArg, portArg] = args;
  const port = Number(portArg);

  if (
    !workspaceArg ||
    !path.isAbsolute(workspaceArg) ||
    workspaceArg.includes("\0") ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    failStartup();
  } else {
    let workspaceRoot;
    try {
      workspaceRoot = await realpath(workspaceArg);
      if (!(await stat(workspaceRoot)).isDirectory()) throw new Error("not a directory");
    } catch {
      failStartup();
      workspaceRoot = undefined;
    }

    if (workspaceRoot) {
      const root = workspaceRoot;

      function isWithinRoot(candidate) {
        const relative = path.relative(root, candidate);
        return relative === "" || (
          relative !== ".." &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative)
        );
      }

      function hasDotSegment(relativePath) {
        return relativePath.split(path.sep).some((segment) => segment.startsWith("."));
      }

      function parseRequestPath(requestUrl) {
        const queryIndex = requestUrl.indexOf("?");
        const hashIndex = requestUrl.indexOf("#");
        const end = [queryIndex, hashIndex]
          .filter((index) => index >= 0)
          .sort((left, right) => left - right)[0] ?? requestUrl.length;
        const rawPath = requestUrl.slice(0, end);
        if (!rawPath.startsWith("/")) return { kind: "bad-request" };

        let decodedPath;
        try {
          decodedPath = decodeURIComponent(rawPath);
        } catch {
          return { kind: "bad-request" };
        }
        if (
          decodedPath.includes("\0") ||
          decodedPath.includes("\\") ||
          decodedPath.split("/").some((segment) => segment === "." || segment === "..")
        ) {
          return { kind: "bad-request" };
        }

        const relativePath = decodedPath === "/" ? "index.html" : decodedPath.slice(1);
        if (!relativePath || hasDotSegment(relativePath)) return { kind: "not-found" };
        return { kind: "path", relativePath };
      }

      async function resolveFile(relativePath) {
        const directPath = path.resolve(root, relativePath);
        if (!isWithinRoot(directPath)) return { kind: "not-found" };

        // The root entrypoint is intentionally stricter than nested assets:
        // it must be a regular file at the workspace root, not a symlink.
        if (relativePath === "index.html") {
          try {
            const entry = await lstat(directPath);
            if (entry.isSymbolicLink() || !entry.isFile()) return { kind: "not-found" };
          } catch {
            return { kind: "not-found" };
          }
        }

        let fileHandle;
        try {
          // Open first and keep the descriptor. The subsequent canonical-path
          // and inode checks prove that the descriptor refers to the same
          // regular file currently located beneath the workspace root. Reads
          // then use this descriptor, so a host-side path swap cannot redirect
          // them after validation.
          fileHandle = await open(directPath, constants.O_RDONLY | constants.O_NOFOLLOW);
          const heldEntry = await fileHandle.stat();
          if (!heldEntry.isFile()) throw new Error("not a file");

          const resolvedPath = await realpath(directPath);
          if (!isWithinRoot(resolvedPath)) throw new Error("outside root");

          const resolvedRelativePath = path.relative(root, resolvedPath);
          if (!resolvedRelativePath || hasDotSegment(resolvedRelativePath)) {
            throw new Error("hidden path");
          }

          const currentEntry = await stat(resolvedPath);
          if (
            !currentEntry.isFile() ||
            currentEntry.dev !== heldEntry.dev ||
            currentEntry.ino !== heldEntry.ino
          ) {
            throw new Error("path changed during validation");
          }
          return { kind: "file", fileHandle };
        } catch {
          await fileHandle?.close().catch(() => undefined);
          return { kind: "not-found" };
        }
      }

      const mimeTypes = new Map([
        [".html", "text/html; charset=utf-8"],
        [".htm", "text/html; charset=utf-8"],
        [".css", "text/css; charset=utf-8"],
        [".js", "text/javascript; charset=utf-8"],
        [".mjs", "text/javascript; charset=utf-8"],
        [".cjs", "text/javascript; charset=utf-8"],
        [".json", "application/json; charset=utf-8"],
        [".map", "application/json; charset=utf-8"],
        [".svg", "image/svg+xml"],
        [".png", "image/png"],
        [".jpg", "image/jpeg"],
        [".jpeg", "image/jpeg"],
        [".gif", "image/gif"],
        [".webp", "image/webp"],
        [".avif", "image/avif"],
        [".ico", "image/x-icon"],
        [".woff", "font/woff"],
        [".woff2", "font/woff2"],
        [".ttf", "font/ttf"],
        [".otf", "font/otf"],
        [".eot", "application/vnd.ms-fontobject"],
        [".txt", "text/plain; charset=utf-8"],
        [".wasm", "application/wasm"],
      ]);

      function sendResponse(response, statusCode, body, contentType = "text/plain; charset=utf-8") {
        const payload = Buffer.from(body);
        response.writeHead(statusCode, {
          "Content-Type": contentType,
          "Content-Length": payload.length,
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
        });
        if (response.req?.method !== "HEAD") response.end(payload);
        else response.end();
      }

      const server = createServer(async (request, response) => {
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.setHeader("Allow", "GET, HEAD");
          sendResponse(response, 405, "Method Not Allowed\n");
          return;
        }

        const parsed = parseRequestPath(request.url ?? "");
        if (parsed.kind === "bad-request") {
          sendResponse(response, 400, "Bad Request\n");
          return;
        }
        if (parsed.kind === "not-found") {
          sendResponse(response, 404, "Not Found\n");
          return;
        }

        const resolved = await resolveFile(parsed.relativePath);
        if (resolved.kind !== "file") {
          sendResponse(response, 404, "Not Found\n");
          return;
        }

        try {
          const payload = await resolved.fileHandle.readFile();
          const extension = path.extname(parsed.relativePath).toLowerCase();
          sendResponse(response, 200, payload, mimeTypes.get(extension) ?? "application/octet-stream");
        } catch {
          // Keep host paths and filesystem details out of runtime logs and
          // responses. The request is retried by the Preview UI if needed.
          console.error("[preview-static] failed to read requested file");
          sendResponse(response, 500, "Internal Server Error\n");
        } finally {
          await resolved.fileHandle.close().catch(() => undefined);
        }
      });

      server.on("error", () => {
        console.error("[preview-static] failed to listen");
        process.exitCode = 1;
      });

      server.listen(port, "0.0.0.0", () => {
        console.log(`[preview-static] listening on 0.0.0.0:${port}`);
      });

      const shutdown = () => {
        server.close(() => process.exit(0));
      };
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
    }
  }
}
