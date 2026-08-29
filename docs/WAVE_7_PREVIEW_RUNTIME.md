# Wave 7 preview runtime

Wave 7 adds a local preview control plane for applications created in an
Agent's persistent workspace. The Codex worker remains disposable; previews
are separate managed containers that mount only the owning Agent workspace at
`/workspace`.

The backend owns workspace resolution, command detection, localhost port
allocation, lifecycle, persistence, authorization calls, and bounded log
redaction. The resolver gives supported npm-based Vite, Next.js, and the
narrow Express/Node start shape priority. If none is detected, a regular
workspace-root `index.html` selects static preview mode. A malformed or
unsupported `package.json` does not block that fallback. If neither a
supported package runtime nor a root entrypoint exists, the backend returns a
normalized preview error; Wave 7 does not install dependencies automatically.

Static previews run the fixed, repository-owned
`/opt/launchpad/preview-static-server.mjs` command on container port `4173`.
The server accepts only `GET` and `HEAD`, maps `/` to the root `index.html`,
and serves existing regular files by exact path. Missing files, directories,
dotfiles, traversal attempts, and symlink escapes return a failure response;
there is no directory listing or SPA history fallback. Static workspaces are
mounted read-only. The runtime image must be rebuilt after changing the
bundled script; custom preview images must contain Node.js and that script at
the fixed path.

Preview host ports bind to `127.0.0.1`, use the configured container image and
resource limits, and receive the same no-new-privileges/capability-drop
defaults as the worker container. The UI intentionally offers **Open Preview**
in a new window. The current app has no arbitrary local-port proxy, so a
server running inside a separate container or remote host cannot make a
loopback preview reachable through the control-plane URL without future proxy
work.

On server restart, in-flight records become `interrupted` and known managed
runtime handles are cleaned up best-effort. The user starts the preview again;
durable resume is not claimed. Agent stop and delete clean up active preview
runtimes before changing Agent lifecycle/workspace state.

Preview operation failures retain the backend's normalized `errorMessage` and
`errorCode` through the HTTP response. The Preview panel displays that message
and code, including command-detection failures, instead of replacing them
with generic HTTP status text. These local preview errors clear on retry,
success, and Agent selection changes; they do not duplicate the application's
global error banner.

The repository-owned `AuthorizationService` is currently permissive for the
single-user local product. Every inspect/start/restart/stop/log operation
crosses that seam so Wave 8 can add policy without hardcoded roles. No safe
Codex platform-tool extension exists in the current runtime, so Agent-callable
preview tools are intentionally deferred rather than exposing a container
socket or faking tool enforcement through prompts.
