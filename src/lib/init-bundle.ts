import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** A complete file carried by an initialization attempt. */
export interface InitWorkspaceFile {
  path: string;
  content: string;
}

export type InitWorkspaceBundleResult =
  | { ok: true; files: InitWorkspaceFile[] }
  | { ok: false; error: string };

const REQUIRED_FILES = ["world.md", "player.md", "rules.md"] as const;
const FILE_HEADER_RE = /^===\s*FILE:\s*(.*?)\s*===$/;

/**
 * Parse and validate the complete bundle emitted by the Pi init prompt.
 *
 * Parsing is intentionally strict. An init attempt is either a complete set
 * of files or it is rejected; callers must not apply a partially parsed set.
 */
export function parseInitWorkspaceBundle(raw: string): InitWorkspaceBundleResult {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, error: "init bundle is empty" };
  }

  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const files: InitWorkspaceFile[] = [];
  let currentPath: string | null = null;
  let currentBody: string[] = [];

  const finish = (): void => {
    if (currentPath === null) return;
    const content = currentBody.join("\n").trim();
    files.push({ path: currentPath, content });
    currentPath = null;
    currentBody = [];
  };

  for (const line of lines) {
    const match = line.match(FILE_HEADER_RE);
    if (match) {
      finish();
      currentPath = match[1] ?? "";
      continue;
    }
    if (currentPath === null) {
      if (line.trim() !== "") return { ok: false, error: "text outside init bundle file sections" };
      continue;
    }
    currentBody.push(line);
  }
  finish();

  const validationError = validateInitWorkspaceFiles(files);
  return validationError ? { ok: false, error: validationError } : { ok: true, files };
}

/** Validate a parsed file list without touching the workspace. */
export function validateInitWorkspaceFiles(files: InitWorkspaceFile[]): string | null {
  if (!Array.isArray(files) || files.length === 0) return "init bundle has no files";

  const seen = new Set<string>();
  for (const file of files) {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") {
      return "init bundle contains malformed file";
    }
    if (!isAllowedInitPath(file.path)) return `init bundle path not allowed: ${file.path}`;
    if (seen.has(file.path)) return `init bundle duplicate file: ${file.path}`;
    seen.add(file.path);
    if (file.content.trim() === "") return `init bundle file is empty: ${file.path}`;
    if (isPlaceholderContent(file.content)) return `init bundle file is placeholder: ${file.path}`;
  }

  for (const required of REQUIRED_FILES) {
    const matches = files.filter((file) => file.path === required);
    if (matches.length !== 1) return `init bundle requires exactly one ${required}`;
  }
  if (!files.some((file) => file.path.startsWith("actors/"))) {
    return "init bundle requires at least one actors/*.md file";
  }
  return null;
}

/**
 * Apply a validated bundle. All input validation happens before any target is
 * touched, so an invalid attempt cannot partially overwrite conceptual files.
 * A temporary directory is used for valid writes to avoid exposing a half
 * written file body to a concurrent reader.
 */
export async function applyInitWorkspaceBundle(
  workspaceDir: string,
  bundle: InitWorkspaceFile[] | string,
): Promise<void> {
  const parsed = typeof bundle === "string" ? parseInitWorkspaceBundle(bundle) : { ok: true as const, files: bundle };
  if (!parsed.ok) throw new Error(parsed.error);
  const validationError = validateInitWorkspaceFiles(parsed.files);
  if (validationError) throw new Error(validationError);

  const stageRoot = path.join(workspaceDir, "turn", `.init-bundle-${crypto.randomUUID()}`);
  try {
    await fs.mkdir(stageRoot, { recursive: true });
    for (const file of parsed.files) {
      const staged = path.join(stageRoot, file.path);
      await fs.mkdir(path.dirname(staged), { recursive: true });
      await fs.writeFile(staged, `${file.content.trimEnd()}\n`);
    }
    for (const file of parsed.files) {
      const staged = path.join(stageRoot, file.path);
      const target = path.join(workspaceDir, file.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.rename(staged, target);
    }
  } finally {
    await fs.rm(stageRoot, { recursive: true, force: true });
  }
}

function isAllowedInitPath(file: string): boolean {
  if (REQUIRED_FILES.includes(file as (typeof REQUIRED_FILES)[number])) return true;
  // POSIX workspace paths only: reject Windows separators, absolute paths,
  // drive prefixes, traversal, and nested actor directories.
  if (
    file.includes("\\") ||
    file.includes("\0") ||
    file.startsWith("/") ||
    /^[A-Za-z]:/.test(file) ||
    file.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    return false;
  }
  return /^actors\/[^/\\]+\.md$/.test(file);
}

function isPlaceholderContent(content: string): boolean {
  // Keep this aligned with workspace.ts while avoiding false positives when
  // canon merely discusses TODOs or uses the English word "placeholder".
  return content.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return (
      /^（占位(?:[：:].*)?）?$/u.test(trimmed) ||
      /^占位(?:\s*[：:].*)?$/u.test(trimmed) ||
      /^#?\s*(?:TODO|TBD)(?:\s*[：:].*)?$/iu.test(trimmed)
    );
  });
}
