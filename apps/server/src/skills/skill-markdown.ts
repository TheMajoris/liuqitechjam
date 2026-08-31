import type { CreateSkillInput } from "./skill-service.js";

/** Maximum source document size accepted by the Markdown import boundary. */
export const MAX_SKILL_MARKDOWN_BYTES = 64 * 1024;

function cleanScalar(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function listValue(value: string): string[] {
  const normalized = cleanScalar(value).replace(/^\[|\]$/g, "");
  return normalized.split(",").map(cleanScalar).filter(Boolean);
}

function parseFrontmatter(source: string): Map<string, string> {
  const metadata = new Map<string, string>();
  let activeListKey: string | null = null;
  let activeList: string[] = [];
  const flushList = () => {
    if (activeListKey !== null && activeList.length > 0) {
      metadata.set(activeListKey, `[${activeList.join(",")}]`);
    }
    activeListKey = null;
    activeList = [];
  };

  for (const line of source.split("\n")) {
    const field = /^([a-zA-Z][\w-]*):\s*(.*)$/.exec(line);
    if (field) {
      flushList();
      activeListKey = field[1]!.toLocaleLowerCase();
      metadata.set(activeListKey, field[2]!);
      continue;
    }
    const item = /^\s*-\s+(.+?)\s*$/.exec(line);
    if (item && activeListKey !== null && metadata.get(activeListKey)?.trim() === "") {
      activeList.push(item[1]!);
      continue;
    }
    if (line.trim() !== "") flushList();
  }
  flushList();
  return metadata;
}

function slug(value: string): string {
  return value.toLocaleLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "imported-skill";
}

function firstParagraph(markdown: string): string {
  return markdown
    .split(/\n\s*\n/)
    .map((part) => part.replace(/^#+\s+.*$/gm, "").trim())
    .find(Boolean)?.replace(/\s+/g, " ").slice(0, 500) ?? "Imported Markdown skill";
}

/** Parse the safe metadata subset commonly used by SKILL.md files. */
export function parseSkillMarkdown(markdown: string, fileName = "SKILL.md"): CreateSkillInput {
  const source = markdown.replace(/^\uFEFF/, "").trim();
  if (!source || Buffer.byteLength(source, "utf8") > MAX_SKILL_MARKDOWN_BYTES) {
    throw new Error("Skill Markdown must be between 1 byte and 64 KB");
  }
  const metadata = new Map<string, string>();
  let instructions = source;
  const frontmatter = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(source);
  if (frontmatter) {
    for (const [key, value] of parseFrontmatter(frontmatter[1]!)) metadata.set(key, value);
    instructions = source.slice(frontmatter[0].length).trim();
  }
  if (!instructions) throw new Error("Skill Markdown must contain instructions");
  const heading = /^#\s+(.+)$/m.exec(instructions)?.[1]?.trim();
  const name = cleanScalar(metadata.get("name") ?? heading ?? fileName.replace(/\.md$/i, ""));
  const description = cleanScalar(metadata.get("description") ?? firstParagraph(instructions));
  const requestedId = cleanScalar(metadata.get("id") ?? name);
  return {
    id: slug(requestedId),
    name: name.slice(0, 120),
    description: description.slice(0, 500),
    instructions,
    requiredToolIds: listValue(metadata.get("requiredtoolids") ?? metadata.get("required-tools") ?? ""),
    capabilityTags: listValue(metadata.get("capabilitytags") ?? metadata.get("tags") ?? ""),
    version: cleanScalar(metadata.get("version") ?? "1.0.0"),
  };
}

/** Convert common GitHub file/folder links to a raw SKILL.md URL. */
export function normalizeSkillUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.hostname !== "github.com") return url.toString();
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 5 || (parts[2] !== "blob" && parts[2] !== "tree")) return url.toString();
  const [owner, repo, kind, ref, ...rest] = parts;
  if (kind === "tree" && rest.at(-1)?.toLocaleLowerCase() !== "skill.md") rest.push("SKILL.md");
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${rest.join("/")}`;
}
