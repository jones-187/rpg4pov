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
 *
 * **detail 字段（Issue 6 扩展）**：可选的诊断详情字段。
 * 用于承载 ClaudeCodeRunner 失败时的脱敏+限长 stdout/stderr 摘要
 * （经 sanitizeForLog 处理），便于事后审计失败原因。
 * 调用方负责脱敏，本函数原样写入。不传 detail 时省略该字段，向后兼容。
 *
 * @param storyId 故事 ID（UUID v4），非法则静默返回
 * @param entry 日志条目：reason 必填，input/detail 可选
 */
export async function appendTurnError(
  storyId: string,
  entry: { reason: string; input?: string; detail?: string },
): Promise<void> {
  try {
    if (!isValidStoryId(storyId)) return;
    const logPath = path.join(resolveWorkspaceDir(storyId), "logs", "turn-errors.log");
    const line = JSON.stringify({
      at: new Date().toISOString(),
      storyId,
      reason: entry.reason,
      ...(entry.input !== undefined ? { input: entry.input } : {}),
      ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
    });
    await fs.appendFile(logPath, line + "\n");
  } catch {
    // best-effort：吞掉，不覆盖原始失败
  }
}
