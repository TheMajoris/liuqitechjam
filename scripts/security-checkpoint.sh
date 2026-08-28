#!/usr/bin/env bash
#
# security-checkpoint.sh - live proof of the Kill Switch boundary.
#
# Runs the plan's "Security checkpoint: Tasks 0-7" checks that need a real
# container engine (the automated suite covers everything else):
#
#   1. npm run check + secret sweep are green.
#   2. The gateway sidecar starts and serves /internal/health.
#   3. A container on the runtime<->gateway network CAN reach the gateway.
#   4. The same container CANNOT reach the public internet.
#   5. A generated secretless container invocation names no provider key.
#
# Requires: docker (or podman via CONTAINER_ENGINE), node 22+, an internet
# connection for the negative egress check. No provider credential is needed -
# the checkpoint uses the deterministic mock provider only.
#
# Usage:  bash scripts/security-checkpoint.sh
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

ENGINE="${CONTAINER_ENGINE:-docker}"
NET="launchpad-checkpoint-net"
GW_NAME="launchpad-checkpoint-gateway"
GW_IMAGE="volc-agent-launchpad:local"
PROBE_IMAGE="${CONTAINER_RUNTIME_BASE_IMAGE:-node:22-bookworm-slim}"
ADMIN_TOKEN="checkpoint-admin-token-0123456789abcd"
PASS=0
FAIL=0

log()  { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL + 1)); }

cleanup() {
  "$ENGINE" rm -f "$GW_NAME" >/dev/null 2>&1 || true
  "$ENGINE" network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

command -v "$ENGINE" >/dev/null 2>&1 || { echo "container engine '$ENGINE' not found" >&2; exit 1; }
"$ENGINE" info >/dev/null 2>&1 || { echo "'$ENGINE' is installed but not running" >&2; exit 1; }

log "1. Static gate: npm run check + secret sweep"
if npm run check >/tmp/checkpoint-check.log 2>&1; then ok "npm run check"; else bad "npm run check (see /tmp/checkpoint-check.log)"; fi
if bash scripts/secret-sweep.sh >/dev/null 2>&1; then ok "secret sweep clean"; else bad "secret sweep found a hit"; fi

log "2. Build the app/gateway image"
"$ENGINE" build -t "$GW_IMAGE" -f Dockerfile . >/tmp/checkpoint-build.log 2>&1 \
  && ok "image built" || { bad "image build failed (see /tmp/checkpoint-build.log)"; exit 1; }

log "3. Start the gateway sidecar (mock provider only)"
"$ENGINE" network create "$NET" >/dev/null
"$ENGINE" run -d --name "$GW_NAME" --network "$NET" \
  -e MODEL_GATEWAY_HOST=0.0.0.0 -e MODEL_GATEWAY_PORT=4000 \
  -e MODEL_GATEWAY_ADMIN_TOKEN="$ADMIN_TOKEN" \
  "$GW_IMAGE" node apps/server/dist/gateway/main.js >/dev/null
sleep 2
if "$ENGINE" run --rm --network "$NET" "$PROBE_IMAGE" \
     node -e "fetch('http://$GW_NAME:4000/internal/health').then(r=>r.json()).then(j=>{if(!j.ok)process.exit(1);console.log(JSON.stringify(j))}).catch(()=>process.exit(1))"; then
  ok "gateway /internal/health reachable on the internal network"
else
  bad "gateway health check failed"
fi

log "4. Negative egress: a runtime-network container cannot reach the internet"
if "$ENGINE" run --rm --network "$NET" "$PROBE_IMAGE" \
     node -e "fetch('https://example.com',{signal:AbortSignal.timeout(5000)}).then(()=>process.exit(0)).catch(()=>process.exit(3))" >/dev/null 2>&1; then
  bad "container reached example.com - the runtime network is NOT isolated"
else
  ok "public internet is unreachable from the runtime network"
fi
if "$ENGINE" run --rm --network "$NET" "$PROBE_IMAGE" \
     node -e "fetch('http://$GW_NAME:4000/internal/health').then(()=>process.exit(0)).catch(()=>process.exit(3))" >/dev/null 2>&1; then
  ok "the gateway itself is still reachable"
else
  bad "gateway unreachable on the isolated network"
fi

log "5. Generated secretless invocation names no provider key"
node --input-type=module -e "
import { buildContainerRunArgs } from './apps/server/dist/container-codex-runner.js';
import { loadConfig } from './apps/server/dist/config.js';
const config = loadConfig({ NODE_ENV:'test', RUNTIME_PROVIDER:'container', ARK_API_KEY:'KEY-SHOULD-NOT-LEAK', ARK_MODEL:'ep-x' });
const args = buildContainerRunArgs({ agentId:'a', workspacePath:'/w', prompt:'p', threadId:null, runId:'r1', gateway:{ gatewayUrl:'http://gw:4000', leaseToken:'glease_should_not_leak_value', providerId:'mock', model:'mock-model', codexHome:'/tmp/r1' } }, config);
const joined = args.join(' ');
if (joined.includes('KEY-SHOULD-NOT-LEAK') || joined.includes('glease_should_not_leak_value') || args.includes('ARK_API_KEY')) { console.error(joined); process.exit(1); }
if (!args.includes('MODEL_GATEWAY_TOKEN')) process.exit(2);
" && ok "argv carries only MODEL_GATEWAY_* env names, no key or lease value" \
  || bad "secret material found in generated container argv"

log "Result"
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
printf '\n\033[32mSecurity checkpoint PASSED.\033[0m Record sign-off in docs/DEVIATIONS.md.\n'
