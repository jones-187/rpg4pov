import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const STORY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_TITLE = "未命名故事";

export interface StoryMeta {
  storyId: string;
  title: string;
  createdAt: string;
  /** Issue 7：初始化 agent 提交后由 Web 侧写 frontmatter，agent 无权写 story.md */
  initialized: boolean;
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
  await fs.writeFile(path.join(dir, "adjustments.md"), ADJUSTMENTS_MD);
  await fs.writeFile(path.join(dir, "tendencies.md"), TENDENCIES_MD);
  await fs.writeFile(path.join(dir, "actors", ".gitkeep"), "");
  await fs.writeFile(path.join(dir, "logs", ".gitkeep"), "");
  await fs.writeFile(path.join(dir, "turn", "input.md"), TURN_INPUT_PLACEHOLDER);
  await fs.writeFile(path.join(dir, "turn", "output.md"), TURN_OUTPUT_PLACEHOLDER);
  await fs.writeFile(path.join(dir, "turns", "history.jsonl"), ""); // Issue 6.5

  return { storyId, title, createdAt, initialized: false };
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

/**
 * 随机判定日志文件名（logs/random-rolls.jsonl）。
 * 定义在 workspace（random-tool 单向依赖 workspace，反向会成环）；random-tool re-export。
 */
export const RANDOM_ROLLS_LOG = "random-rolls.jsonl";

/**
 * 读取随机判定日志的原始行（Issue 9）。
 * 供 orchestrator 做输出隔离校验：output.md 逐字包含某行 = 内部日志外泄。
 * 文件不存在/非法 storyId 返回 []；空行忽略，行内容 trim。
 */
export async function readRandomRollLines(storyId: string): Promise<string[]> {
  if (!isValidStoryId(storyId)) return [];
  try {
    const raw = await fs.readFile(
      path.join(resolveWorkspaceDir(storyId), "logs", RANDOM_ROLLS_LOG),
      "utf8",
    );
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  } catch {
    return [];
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
  const parts = splitStoryMd(raw);
  if (!parts) return null;
  const map: Record<string, string> = {};
  for (const line of parts.frontmatterLines) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    map[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  if (!map.id || !map.title || !map.createdAt) return null;
  return { storyId: map.id, title: map.title, createdAt: map.createdAt, initialized: map.initialized === "true" };
}

/**
 * Issue 7：把 story.md frontmatter 标记为已初始化（Web 侧权威，agent 无权写 story.md）。
 * 保留其余 frontmatter 键与正文，只追加/覆盖 initialized 与 initializedAt。
 * 调用方（TurnOrchestrator 提交阶段）失败时整体回滚，不会留下"已标记但未提交"状态。
 */
export async function markStoryInitialized(storyId: string): Promise<void> {
  if (!isValidStoryId(storyId)) throw new Error("invalid storyId");
  const file = path.join(resolveWorkspaceDir(storyId), "story.md");
  const raw = await fs.readFile(file, "utf8");
  const parts = splitStoryMd(raw);
  if (!parts) throw new Error("story.md frontmatter missing or malformed");

  const lines = parts.frontmatterLines.filter(
    (line) => line.split(":", 1)[0].trim() !== "initialized" && line.split(":", 1)[0].trim() !== "initializedAt",
  );
  lines.push(`initialized: true`);
  lines.push(`initializedAt: ${new Date().toISOString()}`);

  await fs.writeFile(file, `---\n${lines.join("\n")}\n---\n${parts.body}`);
}

const RULES_MD = `# 规则\n\n（占位：故事运行规则。后续初始化 agent 填充，例如判定风格与随机权重约定。）\n`;
const WORLD_MD = `# 世界设定\n\n（占位：场景、地点、时间与隐藏事实。后续初始化 agent 填充。）\n`;
const PLAYER_MD = `# 主角\n\n（占位：主角角色卡与主角已知信息。后续初始化 agent 填充。）\n`;
/** Issue 9.5：Confirmed Adjustments / Inferred Tendencies 初始为空（无玩家反馈/行为记录）。 */
const ADJUSTMENTS_MD = `# Confirmed Adjustments（玩家确认修正）\n\n（空：玩家尚未确认任何长期修正。）\n`;
const TENDENCIES_MD = `# Inferred Tendencies（推测倾向）\n\n（空：尚无带 evidence 与 confidence 的推测记录。）\n`;
const TURN_INPUT_PLACEHOLDER = `# 本回合输入\n\n（占位：主角本回合输入将写入这里。）\n`;
/** createStory 写入的 output.md 原文。Orchestrator 用精确比对识别"runner 未写 output"。 */
export const TURN_OUTPUT_PLACEHOLDER = `# 本回合主角可见输出\n\n（占位：本回合固定主角可见输出。Web 只读取此文件返回用户。）\n`;
/** 概念文档占位标记：初始化提交时这些文件不得再含此标记 */
const PLACEHOLDER_MARK = "（占位";

function storyMd(id: string, title: string, createdAt: string): string {
  return `---\nid: ${id}\ntitle: ${title}\ncreatedAt: ${createdAt}\n---\n\n# 故事\n\n（占位：故事元数据。真实设定由后续初始化 agent 填充。）\n`;
}

/**
 * 拆分 story.md：frontmatter 原始行（保留顺序）+ 正文。
 * parseStoryMd 与 markStoryInitialized 共用，保证只有一个 frontmatter 解析实现。
 */
function splitStoryMd(raw: string): { frontmatterLines: string[]; body: string } | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  return { frontmatterLines: m[1].split("\n"), body: m[2] };
}

/**
 * 初始化提交校验（Issue 7，Seam 8 "required conceptual documents are present"）。
 * 检查初始化 agent 是否真的填充了概念文档，而不只是写了 output/done：
 * - world.md / player.md / rules.md 不得仍含占位标记
 * - actors/ 下至少有一张 NPC 角色卡（.gitkeep 不算）
 * 返回 null 表示通过；否则返回失败原因（Orchestrator 转 failTurn 回滚）。
 */
export async function validateInitWorkspace(storyId: string): Promise<string | null> {
  if (!isValidStoryId(storyId)) return "invalid storyId";
  const dir = resolveWorkspaceDir(storyId);
  for (const file of ["world.md", "player.md", "rules.md"]) {
    let content: string;
    try {
      content = await fs.readFile(path.join(dir, file), "utf8");
    } catch {
      return `init validation failed: ${file} missing`;
    }
    if (content.includes(PLACEHOLDER_MARK)) {
      return `init validation failed: ${file} still placeholder`;
    }
  }
  let actorEntries: string[];
  try {
    actorEntries = await fs.readdir(path.join(dir, "actors"));
  } catch {
    return "init validation failed: actors/ missing";
  }
  const hasActorCard = actorEntries.some((name) => name.endsWith(".md"));
  if (!hasActorCard) {
    return "init validation failed: no NPC actor card in actors/";
  }
  return null;
}
