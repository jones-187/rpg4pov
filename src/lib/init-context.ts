import { promises as fs } from "node:fs";
import path from "node:path";

/** Files whose complete scaffold text is pre-injected for either init runner. */
export const INIT_SKELETON_FILES = ["story.md", "world.md", "player.md", "rules.md"] as const;

/**
 * Read the shared initialization scaffold context. Missing files retain the
 * same explicit marker used by both Claude and Pi prompt builders.
 */
export async function readInitSkeletonContext(workspaceDir: string): Promise<string> {
  const parts: string[] = [];
  for (const file of INIT_SKELETON_FILES) {
    let content: string;
    try {
      content = (await fs.readFile(path.join(workspaceDir, file), "utf8")).trimEnd();
    } catch {
      content = "（不存在）";
    }
    parts.push(`=== ${file} ===\n${content}`);
  }
  return parts.join("\n\n");
}

/**
 * Build the deliberately small context used by Pi's opening phase. This is
 * not a second skeleton dump: only player-visible fields and each actor's
 * title, surface appearance, and voice are copied. Private world/actor
 * sections are therefore never present in the opening prompt by construction.
 */
export async function readInitOpeningContext(workspaceDir: string): Promise<string> {
  const parts: string[] = [];
  const player = await readFileOrMarker(path.join(workspaceDir, "player.md"));
  parts.push("=== player.md（主角可见初始化信息） ===");
  const playerSections: Array<[string, string[]]> = [
    ["初始状态", ["初始状态", "initial state"]],
    ["主角已知信息", ["主角已知信息", "protagonist known information", "known information"]],
    ["Protagonist Core", ["Protagonist Core"]],
    ["Player Agency", ["Player Agency", "Player Agency Boundaries", "Agency Boundaries"]],
  ];
  for (const [label, aliases] of playerSections) {
    parts.push(`## ${label}`);
    parts.push(findSectionBody(player, aliases) || "（未提供）");
  }

  const actorDir = path.join(workspaceDir, "actors");
  let names: string[] = [];
  try {
    names = (await fs.readdir(actorDir)).filter((name) => /^[^/\\]+\.md$/u.test(name)).sort();
  } catch {
    // An empty actor directory is handled as an empty visible roster.
  }
  for (const name of names) {
    const content = await readFileOrMarker(path.join(actorDir, name));
    const title = extractFirstHeading(content) || name.replace(/\.md$/u, "");
    parts.push(`\n=== actors/${name}（主角可见信息） ===`);
    parts.push(`# ${title}`);
    parts.push("## 表面形象");
    parts.push(findSectionBody(content, ["表面形象", "surface appearance"]) || "（未提供）");
    parts.push("## voice");
    const voiceSection = findSectionBody(content, ["voice", "声音", "说话方式"]);
    parts.push(voiceSection ?? extractCurrentIntentVoice(content) ?? "（未提供）");
  }
  return parts.join("\n");
}

async function readFileOrMarker(file: string): Promise<string> {
  try {
    return (await fs.readFile(file, "utf8")).trimEnd();
  } catch {
    return "";
  }
}

function extractFirstHeading(content: string): string | null {
  const match = content.match(/^\s*#\s+(.+?)\s*$/mu);
  return match?.[1]?.trim() || null;
}

function findSectionBody(content: string, names: string[]): string | null {
  const lines = content.split(/\r?\n/);
  const wanted = new Set(names.map(normalizeHeading));
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index]?.match(/^\s*#{1,6}\s+(.+?)\s*$/);
    if (!match || !wanted.has(normalizeHeading(match[1] ?? ""))) continue;
    const body: string[] = [];
    for (let next = index + 1; next < lines.length; next++) {
      if (/^\s*#{1,6}\s+/.test(lines[next] ?? "")) break;
      body.push(lines[next] ?? "");
    }
    return body.join("\n").trim();
  }
  return null;
}

function extractCurrentIntentVoice(content: string): string | null {
  const currentIntent = findSectionBody(content, ["Current Intent"]);
  if (currentIntent === null) return null;
  for (const line of currentIntent.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:[-*]\s*)?(?:\*\*)?voice(?:\*\*)?\s*[:：]\s*(.+?)\s*$/iu,
    );
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function normalizeHeading(title: string): string {
  return title
    .trim()
    .replace(/[:：].*$/u, "")
    .replace(/[（(].*?[）)]/gu, "")
    .trim()
    .toLocaleLowerCase();
}
