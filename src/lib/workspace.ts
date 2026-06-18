import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const STORY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_TITLE = "未命名故事";

export interface StoryMeta {
  storyId: string;
  title: string;
  createdAt: string;
}

export interface DoneMarker {
  status: string;
  completedAt: string;
}

export function resolveWorkspaceRoot(): string {
  const root = process.env.WORKSPACE_ROOT;
  if (root && root.trim()) return path.resolve(root);
  return path.resolve(process.cwd(), "data", "workspaces");
}

export function isValidStoryId(id: string): boolean {
  return STORY_ID_RE.test(id);
}

/**
 * snapshots 根目录（Issue 4）。
 * 快照存放在 Story Workspace 之外：{WORKSPACE_ROOT}/.snapshots/{storyId}/。
 * 不是 Story Workspace 的一部分——见 CONTEXT.md「Turn Snapshot」。
 * listStories 已用 isValidStoryId 过滤，.snapshots 非 UUID，自动被忽略，零改动。
 */
export function resolveSnapshotsRoot(): string {
  return path.resolve(resolveWorkspaceRoot(), ".snapshots");
}

export function resolveWorkspaceDir(storyId: string): string {
  if (!isValidStoryId(storyId)) throw new Error("invalid storyId");
  return path.resolve(resolveWorkspaceRoot(), storyId);
}

export async function workspaceExists(storyId: string): Promise<boolean> {
  if (!isValidStoryId(storyId)) return false;
  try {
    await fs.access(path.join(resolveWorkspaceDir(storyId), "story.md"));
    return true;
  } catch {
    return false;
  }
}

export async function createStory(opts?: { title?: string }): Promise<StoryMeta> {
  const storyId = crypto.randomUUID();
  const title = normalizeTitle(opts?.title);
  const createdAt = new Date().toISOString();
  const dir = resolveWorkspaceDir(storyId);

  await fs.mkdir(path.join(dir, "actors"), { recursive: true });
  await fs.mkdir(path.join(dir, "logs"), { recursive: true });
  await fs.mkdir(path.join(dir, "turn"), { recursive: true });
  await fs.mkdir(path.join(dir, "turns"), { recursive: true }); // Issue 6.5

  await fs.writeFile(path.join(dir, "story.md"), storyMd(storyId, title, createdAt));
  await fs.writeFile(path.join(dir, "rules.md"), RULES_MD);
  await fs.writeFile(path.join(dir, "world.md"), WORLD_MD);
  await fs.writeFile(path.join(dir, "player.md"), PLAYER_MD);
  await fs.writeFile(path.join(dir, "actors", ".gitkeep"), "");
  await fs.writeFile(path.join(dir, "logs", ".gitkeep"), "");
  await fs.writeFile(path.join(dir, "turn", "input.md"), TURN_INPUT_PLACEHOLDER);
  await fs.writeFile(path.join(dir, "turn", "output.md"), TURN_OUTPUT_PLACEHOLDER);
  await fs.writeFile(path.join(dir, "turns", "history.jsonl"), ""); // Issue 6.5

  return { storyId, title, createdAt };
}

export async function listStories(): Promise<StoryMeta[]> {
  const root = resolveWorkspaceRoot();
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }
  const metas: StoryMeta[] = [];
  for (const name of entries) {
    if (!isValidStoryId(name)) continue;
    const meta = await readStoryMeta(name);
    if (meta) metas.push(meta);
  }
  metas.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return metas;
}

export async function getStory(storyId: string): Promise<StoryMeta | null> {
  if (!isValidStoryId(storyId)) return null;
  return readStoryMeta(storyId);
}

async function readStoryMeta(storyId: string): Promise<StoryMeta | null> {
  try {
    const raw = await fs.readFile(path.join(resolveWorkspaceDir(storyId), "story.md"), "utf8");
    return parseStoryMd(raw);
  } catch {
    return null;
  }
}

export async function readTurnOutput(storyId: string): Promise<string | null> {
  if (!isValidStoryId(storyId)) return null;
  try {
    return await fs.readFile(path.join(resolveWorkspaceDir(storyId), "turn", "output.md"), "utf8");
  } catch {
    return null;
  }
}

export async function writeTurnInput(storyId: string, input: string): Promise<void> {
  if (!isValidStoryId(storyId)) throw new Error("invalid storyId");
  await fs.writeFile(
    path.join(resolveWorkspaceDir(storyId), "turn", "input.md"),
    `# 本回合输入\n\n${input}\n`,
  );
}

export async function readTurnDone(storyId: string): Promise<DoneMarker | null> {
  if (!isValidStoryId(storyId)) return null;
  try {
    const raw = await fs.readFile(
      path.join(resolveWorkspaceDir(storyId), "turn", "done.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as unknown;
    if (!isDoneMarker(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function clearTurnDone(storyId: string): Promise<void> {
  if (!isValidStoryId(storyId)) return;
  try {
    await fs.unlink(path.join(resolveWorkspaceDir(storyId), "turn", "done.json"));
  } catch {
    // 忽略清理失败（文件不存在或权限问题）
  }
}

function isDoneMarker(value: unknown): value is DoneMarker {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.status === "string" && typeof v.completedAt === "string";
}

function normalizeTitle(raw?: string): string {
  const t = typeof raw === "string" ? raw.trim() : "";
  return t || DEFAULT_TITLE;
}

function parseStoryMd(raw: string): StoryMeta | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const map: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    map[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  if (!map.id || !map.title || !map.createdAt) return null;
  return { storyId: map.id, title: map.title, createdAt: map.createdAt };
}

const RULES_MD = `# 规则\n\n（占位：故事运行规则。后续初始化 agent 填充，例如判定风格与随机权重约定。）\n`;
const WORLD_MD = `# 世界设定\n\n（占位：场景、地点、时间与隐藏事实。后续初始化 agent 填充。）\n`;
const PLAYER_MD = `# 主角\n\n（占位：主角角色卡与主角已知信息。后续初始化 agent 填充。）\n`;
const TURN_INPUT_PLACEHOLDER = `# 本回合输入\n\n（占位：主角本回合输入将写入这里。）\n`;
const TURN_OUTPUT_PLACEHOLDER = `# 本回合主角可见输出\n\n（占位：本回合固定主角可见输出。Web 只读取此文件返回用户。）\n`;

function storyMd(id: string, title: string, createdAt: string): string {
  return `---\nid: ${id}\ntitle: ${title}\ncreatedAt: ${createdAt}\n---\n\n# 故事\n\n（占位：故事元数据。真实设定由后续初始化 agent 填充。）\n`;
}
