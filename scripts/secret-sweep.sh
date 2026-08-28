#!/usr/bin/env bash
#
# secret-sweep.sh - fail the build if a credential-shaped value is present in
# the working tree or in generated local state / telemetry.
#
# Scans:
#   * the working tree, excluding .git, node_modules, dist, .data, .local,
#     workspaces, codex-home, *.lock, and package-lock.json
#   * .data/ and .local/ if present (generated store + telemetry JSON)
#
# Looks for:
#   * Bearer <token>            Bearer [A-Za-z0-9._~+/-]{16,}
#   * opaque gateway leases     glease_[A-Za-z0-9_-]{16,}
#   * OpenAI-style keys         sk-[A-Za-z0-9]{16,}
#   * PEM private keys          -----BEGIN [A-Z ]*PRIVATE KEY-----
#   * the literal values of ARK_API_KEY / MODEL_GATEWAY_ADMIN_TOKEN /
#     APP_AUTH_TOKEN from a real .env, if one exists
#
# Known-safe matches (placeholders in .env.example, docs, fixtures) can be
# listed in scripts/secret-sweep.allow - see that file for the format.
#
# Exit status: 0 when clean, 1 when at least one non-allowlisted hit is found.

set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

ALLOW_FILE="scripts/secret-sweep.allow"
ENV_FILE=".env"

# --- patterns ---------------------------------------------------------------
# Assembled from parts so the full regex never appears as a literal line that
# could match itself.
_bearer='Bearer [A-Za-z0-9._~+/-]{16,}'
_lease='glease_[A-Za-z0-9_-]{16,}'
_skkey='sk-[A-Za-z0-9]{16,}'
_pem='-----BEGIN [A-Z ]*PRIVATE KEY-----'
STATIC_PATTERN="${_bearer}|${_lease}|${_skkey}|${_pem}"

# Directories and files never worth scanning.
GREP_EXCLUDES=(
  --exclude-dir=.git
  --exclude-dir=node_modules
  --exclude-dir=dist
  --exclude-dir=.data
  --exclude-dir=.local
  --exclude-dir=workspaces
  --exclude-dir=codex-home
  --exclude='*.lock'
  --exclude='package-lock.json'
  --exclude='secret-sweep.allow'
  --exclude='.env'
)

FOUND=0

# --- allowlist ------------------------------------------------------------
# An allow entry is either:
#   path-fragment:regex   suppress when the hit's file path contains
#                         <path-fragment> AND the matched line matches <regex>
#   literal-fingerprint   suppress when the matched line contains it verbatim
is_allowed() {
  local file="$1" content="$2" entry pathpat rx
  [ -f "$ALLOW_FILE" ] || return 1
  while IFS= read -r entry || [ -n "$entry" ]; do
    case "$entry" in
      '' | '#'*) continue ;;
    esac
    if [[ "$entry" == *:* ]]; then
      pathpat="${entry%%:*}"
      rx="${entry#*:}"
      if [[ "$file" == *"$pathpat"* ]] && grep -Eq -- "$rx" <<<"$content"; then
        return 0
      fi
    elif [[ "$content" == *"$entry"* ]]; then
      return 0
    fi
  done <"$ALLOW_FILE"
  return 1
}

# --- .env value extraction ---------------------------------------------------
env_value() {
  local key="$1" raw
  [ -f "$ENV_FILE" ] || return 0
  raw="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$ENV_FILE" | tail -n1 || true)"
  [ -n "$raw" ] || return 0
  raw="${raw#*=}"
  raw="${raw%\"}"
  raw="${raw#\"}"
  raw="${raw%\'}"
  raw="${raw#\'}"
  printf '%s' "$raw"
}

secret_values=()
for key in ARK_API_KEY MODEL_GATEWAY_ADMIN_TOKEN APP_AUTH_TOKEN; do
  value="$(env_value "$key")"
  if [ -n "$value" ] && [ "${value#replace-}" = "$value" ] && [ "${#value}" -ge 8 ]; then
    secret_values+=("$value")
  fi
done

# --- gather raw hits (path:line:content) -----------------------------------
gather() {
  grep -rnIE "$STATIC_PATTERN" . "${GREP_EXCLUDES[@]}" 2>/dev/null || true

  for extra in .data .local; do
    if [ -d "$extra" ]; then
      grep -rnIE "$STATIC_PATTERN" "$extra" --include='*.json' --include='*.log' \
        --include='*.ndjson' 2>/dev/null || true
    fi
  done

  if [ "${#secret_values[@]}" -gt 0 ]; then
    for value in "${secret_values[@]}"; do
      grep -rnIF -- "$value" . "${GREP_EXCLUDES[@]}" 2>/dev/null || true
      for extra in .data .local; do
        [ -d "$extra" ] && { grep -rnIF -- "$value" "$extra" 2>/dev/null || true; }
      done
    done
  fi
}

# --- report ---------------------------------------------------------------
while IFS= read -r raw; do
  [ -n "$raw" ] || continue
  file="${raw%%:*}"
  rest="${raw#*:}"
  line="${rest%%:*}"
  content="${rest#*:}"
  if is_allowed "$file" "$content"; then
    continue
  fi
  printf '%s:%s: %s\n' "$file" "$line" "$content"
  FOUND=1
done < <(gather)

if [ "$FOUND" -ne 0 ]; then
  printf 'secret-sweep: potential secret(s) found (see above)\n' >&2
  exit 1
fi

printf 'secret-sweep: clean\n' >&2
exit 0
