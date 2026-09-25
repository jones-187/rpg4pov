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
const ACTOR_REQUIRED_HEADINGS = [
  "emotional core",
  "relationship state",
  "emotionally salient memories",
  "current intent",
] as const;

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
  for (const actor of files.filter((file) => file.path.startsWith("actors/"))) {
    const actorError = validateActorStructure(actor.content);
    if (actorError) return `${actor.path}: ${actorError}`;
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

function validateActorStructure(content: string): string | null {
  const headings = extractMarkdownHeadings(content);
  const names = new Set(headings.map((heading) => normalizeHeading(heading.title)));
  for (const required of ACTOR_REQUIRED_HEADINGS) {
    if (!names.has(required)) return `actor is missing ${required} heading`;
  }

  const memoriesHeading = headings.find(
    (heading) => normalizeHeading(heading.title) === "emotionally salient memories",
  );
  if (!memoriesHeading) return "actor is missing emotionally salient memories heading";
  const memoriesBody = content
    .split(/\r?\n/)
    .slice(memoriesHeading.bodyStart, memoriesHeading.bodyEnd)
    .join("\n")
    .trim();
  const emptyMemoryMarker = memoriesBody.replace(/[\s（）()[\]。.!！]/gu, "");
  if (
    memoriesBody === "" ||
    emptyMemoryMarker === "初始暂无" ||
    emptyMemoryMarker === "无" ||
    /^0条?$/u.test(emptyMemoryMarker)
  ) {
    return null;
  }
  const memoryEntries = splitMemoryEntries(content, memoriesHeading, headings);
  for (const entry of memoryEntries) {
    for (const field of ["event", "meaning", "impact"] as const) {
      if (!hasMemoryField(entry, field)) return `actor memories are missing ${field}`;
    }
  }
  return null;
}

interface MarkdownHeading {
  title: string;
  level: number;
  bodyStart: number;
  bodyEnd: number;
}

type MemoryField = "event" | "meaning" | "impact";

function splitMemoryEntries(
  content: string,
  memoriesHeading: MarkdownHeading,
  headings: MarkdownHeading[],
): string[] {
  const lines = content.split(/\r?\n/);
  const nestedHeadings = headings.filter(
    (heading) =>
      heading.level > memoriesHeading.level &&
      heading.bodyStart > memoriesHeading.bodyStart &&
      heading.bodyStart <= memoriesHeading.bodyEnd,
  );
  const itemCandidates = nestedHeadings.filter(
    (heading) => normalizeMemoryFieldLabel(heading.title) === null,
  );
  if (itemCandidates.length > 0) {
    const itemLevel = Math.min(...itemCandidates.map((heading) => heading.level));
    return itemCandidates
      .filter((heading) => heading.level === itemLevel)
      .map((heading) => {
        const end = Math.min(heading.bodyEnd, memoriesHeading.bodyEnd);
        return [heading.title, ...lines.slice(heading.bodyStart, end)].join("\n");
      });
  }

  const bodyLines = lines.slice(memoriesHeading.bodyStart, memoriesHeading.bodyEnd);
  const numberedLines = bodyLines
    .map((line, index) => {
      const match = line.match(/^\s*\d+[.)]\s+(.+)$/u);
      return match ? { index, rest: match[1] ?? "" } : null;
    })
    .filter((line): line is { index: number; rest: string } => line !== null);
  const numberedEventStarts = numberedLines
    .filter((line) => normalizeMemoryFieldLabel(line.rest) === "event")
    .map((line) => line.index);
  if (numberedEventStarts.length >= 2) return splitLinesAt(bodyLines, numberedEventStarts);
  if (numberedLines.length >= 2 && numberedEventStarts.length === 0) {
    return splitLinesAt(
      bodyLines,
      numberedLines.map((line) => line.index),
    );
  }

  const eventStarts = bodyLines
    .map((line, index) => (memoryFieldFromLine(line) === "event" ? index : -1))
    .filter((index) => index >= 0);
  if (eventStarts.length >= 2) return splitLinesAt(bodyLines, eventStarts);
  return [bodyLines.join("\n")];
}

function splitLinesAt(lines: string[], starts: number[]): string[] {
  return starts.map((start, index) => lines.slice(start, starts[index + 1]).join("\n"));
}

function hasMemoryField(entry: string, wanted: MemoryField): boolean {
  return entry.split(/\r?\n/).some((line) => memoryFieldFromLine(line) === wanted);
}

function memoryFieldFromLine(line: string): MemoryField | null {
  const heading = line.match(/^\s*#{1,6}\s+(.+?)\s*$/u);
  if (heading) return normalizeMemoryFieldLabel(heading[1] ?? "");
  if (!/[:：]/u.test(line)) return null;
  return normalizeMemoryFieldLabel(line);
}

function normalizeMemoryFieldLabel(value: string): MemoryField | null {
  let label = value.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+)/u, "");
  label = stripMarkdownEmphasis(label).replace(/[:：].*$/u, "").trim();
  label = stripMarkdownEmphasis(label).toLocaleLowerCase();
  if (label === "event" || label === "事件") return "event";
  if (label === "meaning" || label === "含义" || label === "意义") return "meaning";
  if (label === "impact" || label === "影响") return "impact";
  return null;
}

function stripMarkdownEmphasis(value: string): string {
  let result = value.trim();
  while (true) {
    const match = result.match(/^(?:\*\*|__)([\s\S]*)(?:\*\*|__)$/u);
    if (!match) return result;
    result = (match[1] ?? "").trim();
  }
}

function extractMarkdownHeadings(content: string): MarkdownHeading[] {
  const lines = content.split(/\r?\n/);
  const headings: MarkdownHeading[] = [];
  lines.forEach((line, index) => {
    const match = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
    if (!match) return;
    const level = match[1]?.length ?? 1;
    for (const previous of headings) {
      if (previous.level >= level && previous.bodyEnd > index) previous.bodyEnd = index;
    }
    headings.push({
      title: match[2] ?? "",
      level,
      bodyStart: index + 1,
      bodyEnd: lines.length,
    });
  });
  return headings;
}

function normalizeHeading(title: string): string {
  return title
    .trim()
    .replace(/^(?:\*\*|__)([\s\S]*)(?:\*\*|__)$/u, "$1")
    .replace(/[:：].*$/u, "")
    .replace(/[（(].*?[）)]/gu, "")
    .replace(/^(?:\*\*|__)([\s\S]*)(?:\*\*|__)$/u, "$1")
    .replace(/^\d+\s*[.)]\s*/u, "")
    .trim()
    .toLocaleLowerCase();
}
