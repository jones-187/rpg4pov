import type { AgentRunner, TurnResult } from "./agent-runner";
import {
  clearTurnDone,
  readTurnDone,
  readTurnOutput,
  resolveWorkspaceDir,
  writeTurnInput,
} from "./workspace";
import { TurnLock, TurnBusyError } from "./turn-lock";
import {
  createSnapshot,
  restoreSnapshot,
  deleteSnapshot,
  markWorkspaceUnsafe,
  readWorkspaceUnsafeMarker,
} from "./turn-snapshot";
import { appendTurnError } from "./turn-error-log";
import { appendTurnHistory, type TurnHistoryEntry } from "./turn-history";
import crypto from "node:crypto";

/** 默认回合超时 300s（Issue 6）。可经 TURN_TIMEOUT_MS 覆盖。 */
function resolveTurnTimeoutMs(): number {
  const raw = process.env.TURN_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 300000;
}

/**
 * 回合编排结果。Orchestrator → Route。
 * playerResponse 从 turn/output.md 读取，不是 runner 返回值。
 */
export interface TurnOutcome {
  success: boolean;
  playerResponse: string | null;
  error?: string;
  turn?: TurnHistoryEntry; // Issue 6.5: 成功时返回 committed entry
}

/**
 * 回合生命周期编排器（Issue 4 扩展）。
 * 编排：锁 → 快照 → clear done → 写 input → 超时信号 → runner → 磁盘权威检查 → 读 output。
 * 失败路径统一：restore snapshot → best-effort 写错误日志 → 删除快照。
 * 成功路径：删除快照。
 * 锁用 try/finally 保证释放。
 * 持有 AgentRunner 实例 + TurnLock 实例，对回合内的所有失败负责。
 * 不直接 fs，通过各模块读写。
 */
export class TurnOrchestrator {
  private readonly lock = new TurnLock();

  constructor(private runner: AgentRunner) {}

  async executeTurn(storyId: string, playerInput: string): Promise<TurnOutcome> {
    // 0. 检查 workspace 是否被标记为 unsafe（上回合 rollback 失败残留）
    const unsafe = await readWorkspaceUnsafeMarker(storyId);
    if (unsafe) {
      return {
        success: false,
        playerResponse: null,
        error: "workspace unsafe: " + unsafe.reason,
      };
    }

    // 1. 获取串行锁。失败抛 TurnBusyError（route 转 409）。
    //    注意：锁在 snapshot 之前——并发拒绝不应留下半成品快照。
    const release = this.lock.acquire(storyId);
    try {
      return await this.runWithSnapshot(storyId, playerInput);
    } finally {
      release();
    }
  }

  private async runWithSnapshot(
    storyId: string,
    playerInput: string,
  ): Promise<TurnOutcome> {
    // 2. 快照（lock 后第一步）——捕获"本回合开始前的完整提交态"（含上回合 done.json）。
    await createSnapshot(storyId);

    // 3. clearTurnDone 是本回合第一个 mutation，必须在 snapshot 之后。
    await clearTurnDone(storyId);

    // 4. 写入本次主角输入
    await writeTurnInput(storyId, playerInput);

    // 5. 构造回合请求（含超时信号）
    const workspaceDir = resolveWorkspaceDir(storyId);
    const timeoutMs = resolveTurnTimeoutMs();
    const signal = AbortSignal.timeout(timeoutMs);
    const req = { storyId, workspaceDir, playerInput, signal };
    const startedAt = Date.now();

    // 6. 调用 runner（捕获异常，统一转失败）
    let result: TurnResult;
    try {
      result = await this.runner.runTurn(req);
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const isTimeout = err instanceof Error && err.name === "AbortError";
      const reason = isTimeout ? "timeout" : "runner crashed";
      const detail = isTimeout
        ? `timeout after ${durationMs}ms (limit=${timeoutMs}ms)`
        : undefined;
      return await this.failTurn(storyId, reason, playerInput, detail);
    }

    // 7. 磁盘权威检查：done.json 必须存在且 status=success
    const done = await readTurnDone(storyId);
    if (!done || done.status !== "success") {
      // runner 返回 "aborted" 且 signal 已超时 → 改记 "timeout"，附带 duration
      const isTimeout = result.error === "aborted" && signal.aborted;
      const reason = isTimeout ? "timeout" : (result.error ?? "done marker missing");
      const durationMs = Date.now() - startedAt;
      const detail = isTimeout
        ? `timeout after ${durationMs}ms (limit=${timeoutMs}ms)\n${result.detail ?? ""}`
        : result.detail;
      return await this.failTurn(storyId, reason, playerInput, detail);
    }

    // 8. output.md 必须存在且非空
    const playerResponse = await readTurnOutput(storyId);
    if (!playerResponse || playerResponse.trim() === "") {
      return await this.failTurn(storyId, "output missing or empty", playerInput);
    }

    // 9. 成功：append history → 删除快照 → 返回 committed entry
    const turnId = crypto.randomUUID();
    const at = new Date().toISOString();
    const entry: TurnHistoryEntry = {
      turnId,
      at,
      input: playerInput,
      output: playerResponse,
    };

    try {
      await appendTurnHistory(storyId, entry);
    } catch (appendErr) {
      // history append 失败视为本回合失败
      return await this.failTurn(
        storyId,
        `history append failed: ${appendErr instanceof Error ? appendErr.message : String(appendErr)}`,
        playerInput,
      );
    }

    await deleteSnapshot(storyId);
    return { success: true, playerResponse, turn: entry };
  }

  /**
   * 统一失败路径（Issue 4）。
   * 顺序：restore snapshot → best-effort 写错误日志 → 删除快照。
   * 日志在 workspace/logs/ 下，必须在整目录恢复之后写，否则被覆盖丢失。
   * restoreSnapshot 不是 best-effort——如果失败，workspace 可能已脏，
   * 此时写 unsafe marker 并在日志中记录 rollback failed。
   */
  private async failTurn(
    storyId: string,
    reason: string,
    playerInput: string,
    detail?: string,
  ): Promise<TurnOutcome> {
    // restoreSnapshot 单独 try/catch——它不是 best-effort，失败需要诊断
    try {
      await restoreSnapshot(storyId);
    } catch (restoreErr) {
      // restore 失败：workspace 可能已脏。best-effort 写 unsafe marker + 诊断日志
      const rollbackReason = `rollback failed: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`;
      await markWorkspaceUnsafe(storyId, rollbackReason);
      await appendTurnError(storyId, { reason: rollbackReason, input: playerInput });
      // 不删除 snapshot——灾难路径下 snapshot 是后续人工恢复/排查的最后依据
      return { success: false, playerResponse: null, error: reason };
    }

    // restore 成功：best-effort 写错误日志 + 删除快照
    try {
      await appendTurnError(storyId, { reason, input: playerInput, detail });
      await deleteSnapshot(storyId);
    } catch {
      // appendTurnError / deleteSnapshot 是 best-effort，不影响用户响应
    }
    return { success: false, playerResponse: null, error: reason };
  }
}

export { TurnBusyError };
