# Contributing

Keep changes focused, reproducible, and suitable for a three-day student
hackathon.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

For container-based Agent execution, follow
[docs/LOCAL_POC.md](docs/LOCAL_POC.md).

## Validate

Run before every commit:

```bash
npm run check                 # typecheck + test + build (the phase gate)
bash scripts/secret-sweep.sh  # must print "secret-sweep: clean" and exit 0
```

When a container engine is available, also run the live Kill Switch boundary
proof:

```bash
bash scripts/security-checkpoint.sh
```

The inherited infrastructure checks still apply while those files exist:

```bash
terraform fmt -check -recursive deploy/volcengine
docker compose config
```

## Commits

- Small, focused commits; one behavioral change each.
- Never add co-authors or bot trailers to commits.
- The server is NodeNext ESM: import sibling modules with the `.js` suffix
  (`./config.js` for `config.ts`), and `exactOptionalPropertyTypes` is on -
  build optional fields with conditional spreads, never pass `undefined`.
- The gateway (`apps/server/src/gateway/`) is a separate process; it must not
  import Project, orchestration, telemetry, or browser modules.

## Pull requests

- Explain the behavior and reason for the change.
- Add tests for API, lifecycle, persistence, or Runtime changes.
- Update English documentation and `.env.example` when configuration changes.
- Use GitHub Flavored Markdown and relative repository links.
- Never commit credentials, local state, workspaces, build output, or Terraform
  state.
- Report security issues according to [SECURITY.md](SECURITY.md).
