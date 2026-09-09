import { WorkspaceCheckpointError } from "./workspace-checkpoint-types.js";

/**
 * Server-owned limits for one source checkpoint. They are deliberately
 * constants: an Agent cannot negotiate them, and a snapshot that exceeds them
 * is rejected whole rather than silently truncated.
 */
export const CHECKPOINT_LIMITS = {
  maxFiles: 10_000,
  maxFileBytes: 5 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
  maxReadyCheckpointsPerProject: 500,
  gitCommandTimeoutMs: 15_000,
  operationTimeoutMs: 30_000,
  /** Bytes of a file inspected for a NUL byte before it is treated as binary. */
  binaryProbeBytes: 8_000,
} as const;

/** File extensions that count as source, configuration, or documentation. */
const ELIGIBLE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".json", ".md", ".mdx", ".txt", ".html", ".htm", ".css", ".scss", ".sass", ".less",
  ".yaml", ".yml", ".toml", ".xml", ".csv", ".svg",
  ".py", ".go", ".rs", ".java", ".kt", ".rb", ".php", ".cs", ".c", ".h", ".cpp", ".hpp",
  ".sql", ".sh", ".bash", ".ps1", ".bat", ".cmd", ".vue", ".svelte", ".graphql", ".gql",
  ".ini", ".cfg", ".conf", ".properties",
]);

/** Extensionless or dotfile basenames that are ordinary source configuration. */
const ELIGIBLE_BASENAMES = new Set([
  "dockerfile", "makefile", "license", "readme", "changelog", "procfile", "justfile",
  ".gitignore", ".gitattributes", ".editorconfig", ".npmrc", ".nvmrc", ".prettierrc",
  ".eslintrc", ".babelrc", ".dockerignore", ".prettierignore", ".eslintignore",
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
]);

/** Directory names that are never captured, wherever they appear. */
const DENIED_DIRECTORY_NAMES = new Set([
  ".git", ".codex", ".ssh", ".aws", ".azure", ".gcloud", ".config",
  "credentials", "secrets", "node_modules", "dist", "build", "coverage", ".next",
  ".nuxt", ".cache", ".parcel-cache", ".turbo", "tmp", "temp", "logs", "log",
  ".venv", "venv", "__pycache__", ".terraform", ".gradle", "target", ".mypy_cache",
  ".pytest_cache", ".idea", ".lqam",
]);

/** Basenames denied outright, regardless of extension allowlisting. */
const DENIED_BASENAME_PATTERNS: readonly RegExp[] = [
  /^\.env(?:\..*)?$/iu,
  /\.(?:pem|key|p12|pfx|jks|keystore|crt|cer|der|log|asc|gpg|kdbx)$/iu,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?$/iu,
  /(?:^|[._-])(?:credentials?|secrets?|passwd|password|shadow)(?:[._-]|$)/iu,
  /^\.(?:netrc|htpasswd|pypirc|pgpass|git-credentials|docker\/config\.json)$/iu,
  /\.(?:tfvars|tfstate)$/iu,
  /(?:~|\.swp|\.swo|\.bak|\.tmp|\.orig|\.rej)$/iu,
  /^(?:\.ds_store|thumbs\.db|desktop\.ini)$/iu,
];

/** Content patterns that mark a file as unsafe to store, whatever its name. */
const SECRET_CONTENT_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u,
  /\bAIza[0-9A-Za-z_-]{35}\b/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
  /\b(?:_authToken|_auth)\s*=\s*[A-Za-z0-9_\-/+=]{16,}/u,
];

/** `KEY = "value"` shapes; the value is judged separately for randomness. */
const CREDENTIAL_ASSIGNMENT =
  /\b(?:api[_-]?key|apikey|secret(?:[_-]?key)?|password|passwd|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\b\s*(?::|=|=>)\s*["'`]?([A-Za-z0-9_\-/+=.]{16,})["'`]?/giu;

const PLACEHOLDER_VALUE = /^(?:replace|your|example|changeme|dummy|xxx|todo|placeholder|test|sample)/iu;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

export type CheckpointPathDecision =
  | { eligible: true; kind: "file" | "directory" }
  | {
      eligible: false;
      kind: "file" | "directory";
      reason: "denied_path" | "denied_name" | "not_allowlisted";
    };

export interface CheckpointPolicy {
  readonly version: "source-v1";
  classifyPath(relativePath: string, kind: "file" | "directory"): CheckpointPathDecision;
  /** Returns true when the bytes may be stored; throws on a detected secret. */
  scanContent(relativePath: string, content: Buffer, configuredSecrets: readonly string[]): boolean;
}

function basenameOf(relativePath: string): string {
  const index = relativePath.lastIndexOf("/");
  return index === -1 ? relativePath : relativePath.slice(index + 1);
}

function extensionOf(basename: string): string {
  const index = basename.lastIndexOf(".");
  if (index <= 0) return "";
  return basename.slice(index).toLowerCase();
}

/**
 * Reject anything that is not a plain workspace-relative path with forward
 * slashes: traversal, absolute paths, drive letters, NUL/control characters,
 * backslashes, and empty components. The rule is fixed in code so an Agent
 * cannot relax it through a workspace file.
 */
export function validateRelativePath(relativePath: string): void {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw invalidPath();
  }
  if (relativePath.length > 4_096) throw invalidPath();
  if (CONTROL_CHARACTERS.test(relativePath) || relativePath.includes("\\")) {
    throw invalidPath();
  }
  if (relativePath.startsWith("/") || /^[A-Za-z]:/u.test(relativePath)) throw invalidPath();
  for (const component of relativePath.split("/")) {
    if (component.length === 0 || component === "." || component === "..") {
      throw invalidPath();
    }
    if (component.length > 255) throw invalidPath();
  }
}

function invalidPath(): WorkspaceCheckpointError {
  return new WorkspaceCheckpointError(
    "CHECKPOINT_INVALID_INPUT",
    "A workspace path is not a plain relative path",
  );
}

function isDeniedDirectoryName(name: string): boolean {
  return DENIED_DIRECTORY_NAMES.has(name.toLowerCase());
}

function isDeniedBasename(name: string): boolean {
  return DENIED_BASENAME_PATTERNS.some((pattern) => pattern.test(name));
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

/** A literal that looks like a generated credential rather than an identifier. */
function looksLikeSecretLiteral(value: string): boolean {
  if (value.length < 20) return false;
  if (PLACEHOLDER_VALUE.test(value)) return false;
  if (value.includes("${") || value.includes("process.env") || value.startsWith("<")) return false;
  const hasDigit = /\d/u.test(value);
  const hasLetter = /[A-Za-z]/u.test(value);
  const hasBothCases = /[a-z]/u.test(value) && /[A-Z]/u.test(value);
  if (!hasDigit || !hasLetter) return false;
  return shannonEntropy(value) >= 3.3 && (hasBothCases || value.length >= 32);
}

/**
 * Whether a file is binary. The first bytes are probed for NUL; SVG and text
 * formats never contain one. Binary assets are outside source-v1 and are
 * reported as excluded, never claimed as recovered.
 */
export function looksBinary(content: Buffer): boolean {
  const probe = content.subarray(0, Math.min(content.length, CHECKPOINT_LIMITS.binaryProbeBytes));
  return probe.includes(0);
}

export const sourceV1Policy: CheckpointPolicy = {
  version: "source-v1",

  classifyPath(relativePath, kind) {
    validateRelativePath(relativePath);
    const components = relativePath.split("/");
    const basename = components[components.length - 1] ?? "";
    // Every ancestor is checked, so a denied directory hides its whole subtree
    // even when the caller asks about a deep file directly.
    for (const directory of components.slice(0, -1)) {
      if (isDeniedDirectoryName(directory)) {
        return { eligible: false, kind, reason: "denied_path" };
      }
    }
    if (kind === "directory") {
      return isDeniedDirectoryName(basename)
        ? { eligible: false, kind, reason: "denied_path" }
        : { eligible: true, kind };
    }
    if (isDeniedBasename(basename)) return { eligible: false, kind, reason: "denied_name" };
    const lower = basename.toLowerCase();
    if (ELIGIBLE_BASENAMES.has(lower)) return { eligible: true, kind };
    const extension = extensionOf(basename);
    if (extension.length > 0 && ELIGIBLE_EXTENSIONS.has(extension)) {
      return { eligible: true, kind };
    }
    return { eligible: false, kind, reason: "not_allowlisted" };
  },

  scanContent(relativePath, content, configuredSecrets) {
    if (looksBinary(content)) return false;
    // Latin-1 keeps byte offsets stable; every pattern above is ASCII.
    const text = content.toString("latin1");
    for (const secret of configuredSecrets) {
      if (secret.length >= 8 && text.includes(secret)) throw secretDetected(relativePath);
    }
    for (const pattern of SECRET_CONTENT_PATTERNS) {
      if (pattern.test(text)) throw secretDetected(relativePath);
    }
    CREDENTIAL_ASSIGNMENT.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CREDENTIAL_ASSIGNMENT.exec(text)) !== null) {
      const literal = match[1] ?? "";
      if (looksLikeSecretLiteral(literal)) throw secretDetected(relativePath);
    }
    return true;
  },
};

function secretDetected(_relativePath: string): WorkspaceCheckpointError {
  // The path and the matching text are deliberately not part of the error:
  // the code and a count are the only evidence a caller may surface.
  return new WorkspaceCheckpointError(
    "CHECKPOINT_SECRET_DETECTED",
    "Eligible source contains content that looks like a credential; remove it before a checkpoint can be taken",
  );
}

export interface ManifestEntry {
  /** Workspace-relative POSIX path. */
  path: string;
  mode: "100644" | "100755";
  /** Git blob object ID of the exact bytes. */
  oid: string;
  size: number;
}

/** Reject a manifest entry that the current policy would never have captured. */
export function validateManifestEntry(policy: CheckpointPolicy, entry: ManifestEntry): void {
  validateRelativePath(entry.path);
  if (entry.mode !== "100644" && entry.mode !== "100755") {
    throw new WorkspaceCheckpointError("CHECKPOINT_CORRUPT", "A checkpoint entry has an unsupported mode");
  }
  if (!/^[0-9a-f]{40,64}$/u.test(entry.oid)) {
    throw new WorkspaceCheckpointError("CHECKPOINT_CORRUPT", "A checkpoint entry has an invalid object identity");
  }
  if (!Number.isInteger(entry.size) || entry.size < 0 || entry.size > CHECKPOINT_LIMITS.maxFileBytes) {
    throw new WorkspaceCheckpointError("CHECKPOINT_LIMIT_EXCEEDED", "A checkpoint entry exceeds the per-file limit");
  }
  const decision = policy.classifyPath(entry.path, "file");
  if (!decision.eligible) {
    throw new WorkspaceCheckpointError(
      "CHECKPOINT_POLICY_MISMATCH",
      "A recorded checkpoint entry is no longer permitted by the source policy",
    );
  }
}

/** Reject two eligible paths that collide on a case-insensitive filesystem. */
export function assertNoCaseCollisions(paths: readonly string[]): void {
  const seen = new Map<string, string>();
  for (const candidate of paths) {
    const folded = candidate.toLowerCase();
    const existing = seen.get(folded);
    if (existing !== undefined && existing !== candidate) {
      throw new WorkspaceCheckpointError(
        "CHECKPOINT_INVALID_INPUT",
        "Two eligible files differ only by letter case and cannot be restored safely",
      );
    }
    seen.set(folded, candidate);
  }
}
