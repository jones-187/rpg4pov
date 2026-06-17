import { promises as fs } from "node:fs";
import path from "node:path";
import { isValidStoryId, resolveWorkspaceDir } from "./workspace";

/**
 * 失败回合的内部错误日志（Issue 4，US 42）。
 * 写入 workspace/logs/turn-errors.log（JSONL，追加）。
 * 与 turn/output.md（主角可见）严格分离。
 *
 * **best-effort**：日志写入失败不应覆盖原始失败，也不应阻止向用户返回失败响应。
 * 因此本函数吞掉所有异常——调用方只管调，不处理返回。
 *
 * **必须在 restoreSnapshot 之后调用**：本日志位于 workspace/logs/ 下，
 * 属于整目录快照/恢复范围，先写日志再 restore 会被覆盖丢失。
 */
export async function appendTurnError(
  storyId: string,
  entry: { reason: string; input?: string },
): Promise<void> {
  try {
    if (!isValidStoryId(storyId)) return;
    const logPath = path.join(resolveWorkspaceDir(storyId), "logs", "turn-errors.log");
    const line = JSON.stringify({
      at: new Date().toISOString(),
      storyId,
      reason: entry.reason,
      ...(entry.input !== undefined ? { input: entry.input } : {}),
    });
    await fs.appendFile(logPath, line + "\n");
  } catch {
    // best-effort：吞掉，不覆盖原始失败
  }
}
