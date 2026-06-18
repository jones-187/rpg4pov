// src/lib/turn-history.ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { isValidStoryId, resolveWorkspaceDir } from "./workspace";

/**
 * 已提交的玩家可见回合历史条目（Issue 6.5）。
 * 只由 TurnOrchestrator 在成功回合提交阶段追加。
 */
export interface TurnHistoryEntry {
  turnId: string;
  at: string;
  input: string;
  output: string;
}

/**
 * 解析 history.jsonl 文件路径。
 */
function resolveHistoryPath(storyId: string): string {
  return path.join(resolveWorkspaceDir(storyId), "turns", "history.jsonl");
}

/**
 * 追加一条 history entry 到 turns/history.jsonl。
 * 每条 entry 占一行（JSONL 格式）。
 * 自动创建 turns/ 目录（兼容旧 workspace）。
 */
export async function appendTurnHistory(
  storyId: string,
  entry: TurnHistoryEntry,
): Promise<void> {
  if (!isValidStoryId(storyId)) {
    throw new Error("invalid storyId");
  }
  const historyPath = resolveHistoryPath(storyId);
  // 确保父目录存在（Issue 6.5 反馈 1：兼容旧 workspace）
  await fs.mkdir(path.dirname(historyPath), { recursive: true });
  const line = JSON.stringify(entry) + "\n";
  await fs.appendFile(historyPath, line, "utf8");
}

/**
 * 读取 turns/history.jsonl，返回所有已提交的回合历史。
 * 如果文件不存在或为空，返回空数组。
 * 如果 storyId 无效，返回 null。
 * JSON parse 错误、权限错误、其他 IO 错误会抛出（Issue 6.5 反馈 2）。
 */
export async function readTurnHistory(
  storyId: string,
): Promise<TurnHistoryEntry[] | null> {
  if (!isValidStoryId(storyId)) {
    return null;
  }
  const historyPath = resolveHistoryPath(storyId);
  try {
    const raw = await fs.readFile(historyPath, "utf8");
    if (!raw.trim()) {
      return [];
    }
    const lines = raw.trim().split("\n");
    return lines.map((line) => JSON.parse(line) as TurnHistoryEntry);
  } catch (err) {
    // ENOENT（文件不存在）返回空数组
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    // 其他错误（JSON parse、权限、IO）抛出
    throw err;
  }
}