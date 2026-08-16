import type { AgentRunner, RunnerTask, TurnResult } from "./agent-runner";
import {
  clearTurnDone,
  getStory,
  markStoryInitialized,
  readRandomRollLines,
  readTurnDone,
  readTurnOutput,
  resolveWorkspaceDir,
  validateInitWorkspace,
  writeTurnInput,
} from "./workspace";
import { validateTurnOutput } from "./turn-output";
import { TurnLock, TurnBusyError } from "./turn-lock";
import {
  createSnapshot,
  restoreSnapshot,
  deleteSnapshot,
  markWorkspaceUnsafe,
  readWorkspaceUnsafeMarker,
} from "./turn-snapshot";
import { appendTurnError } from "./turn-error-log";
import { appendTurnHistory, readTurnHistoryRaw, type TurnHistoryEntry } from "./turn-history";
import {
  readTurnInteraction,
  readTurnInteractionRawLine,
  type TurnInteraction,
} from "./turn-interaction";
import { CONTINUE_TURN_INPUT_TEXT, CONTINUE_HISTORY_LABEL } from "./claude-prompt";
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
  interaction?: TurnInteraction; // Issue 10: 成功时返回净化后的交互状态
}

/** executeTurn 选项（Issue 10：systemCommand="continue" 为系统级"继续"控制）。 */
export interface ExecuteTurnOptions {
  task?: RunnerTask;
  systemCommand?: "continue";
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

  async executeTurn(
    storyId: string,
    playerInput: string,
    opts?: ExecuteTurnOptions,
  ): Promise<TurnOutcome> {
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
      // 1.5 Issue 7 竞态守卫：锁内复查"已初始化"。
      //     route 层的 409 预检查在锁外，两个并发 initialize 可能都通过预检查；
      //     若不在锁内拦下后到者，它会覆盖前者的 workspace 并追加第二条开场 entry。
      //     此处 plain return（不 failTurn）——尚未发生任何 mutation，无快照可回滚。
      if (opts?.task === "init") {
        const story = await getStory(storyId);
        if (story?.initialized) {
          return { success: false, playerResponse: null, error: "story already initialized" };
        }
      }
      return await this.runWithSnapshot(storyId, playerInput, opts);
    } finally {
      release();
    }
  }

  private async runWithSnapshot(
    storyId: string,
    playerInput: string,
    opts?: ExecuteTurnOptions,
  ): Promise<TurnOutcome> {
    const task = opts?.task;
    // Issue 10：系统级"继续"命令。runner 看到的是系统指令文本（不是主角台词），
    // 玩家可见历史中记录固定标签（不是主角发言），失败日志仍记原始语义。
    const runnerInput =
      opts?.systemCommand === "continue" ? CONTINUE_TURN_INPUT_TEXT : playerInput;
    const historyInput =
      opts?.systemCommand === "continue" ? CONTINUE_HISTORY_LABEL : playerInput;
    // 2. 快照（lock 后第一步）——捕获"本回合开始前的完整提交态"（含上回合 done.json）。
    await createSnapshot(storyId);

    // 2.5 Issue 14：committed history 隔离基准——回合开始时的 turns/history.jsonl 原文。
    //     Agent 运行期间该文件必须保持逐字不变；正式 append 前会与基准比对。
    const historyBaseline = await readTurnHistoryRaw(storyId);

    // 3. clearTurnDone 是本回合第一个 mutation，必须在 snapshot 之后。
    await clearTurnDone(storyId);

    // 4. 写入本次主角输入（continue 命令时为系统指令文本）
    await writeTurnInput(storyId, runnerInput);

    // 5. 构造回合请求（含超时信号）。task=init 时为初始化任务（Issue 7）。
    const workspaceDir = resolveWorkspaceDir(storyId);
    const timeoutMs = resolveTurnTimeoutMs();
    const signal = AbortSignal.timeout(timeoutMs);
    const req = { storyId, workspaceDir, playerInput: runnerInput, task, signal };
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

    // 8. output.md 校验。Web 返回给用户的内容只来自这个文件（US 38/45），
    //    所以"明显不合规"在此拦截并回滚：存在/占位残留（Issue 4，含 runner
    //    只写 done 不写 output 的情形）+ 格式粗判（Issue 9：首行标题契约、
    //    失控超长、JSON 转储、随机日志行逐字外泄）。turn 与 init 共用。
    const playerResponse = await readTurnOutput(storyId);
    if (playerResponse === null) {
      return await this.failTurn(storyId, "output missing or empty", playerInput);
    }
    const rollLines = await readRandomRollLines(storyId);
    // Issue 12 扩展：interaction.json 原文也是内部状态，逐字外泄同样拦截。
    const interactionRawLine = await readTurnInteractionRawLine(storyId);
    const outputProblem = validateTurnOutput(playerResponse, rollLines, [
      ...(interactionRawLine ? [interactionRawLine] : []),
    ]);
    if (outputProblem) {
      return await this.failTurn(storyId, outputProblem, playerInput);
    }

    // 8.5 Issue 7：初始化提交校验——概念文档必须真的被填充（Seam 8），
    //     而不是只写了 output/done。失败走 failTurn 回滚到占位骨架。
    if (task === "init") {
      const problem = await validateInitWorkspace(storyId);
      if (problem) {
        return await this.failTurn(storyId, problem, playerInput);
      }
    }

    // 8.7 Issue 14：committed history 隔离守卫。Agent 只生成候选内容，
    //     player-visible timeline 的 commit 权 exclusively 属于 orchestrator——
    //     逐字比对（非行数），append/rewrite/truncate/伪造条目一律拦截。
    //     必须发生在 orchestrator 自己 append 之前，否则会误判自己的合法写入。
    //     检出污染即整轮回滚（restore snapshot 恢复回合前 history），fail closed，
    //     不做"修复那一行再继续"——越过 ownership 边界后本轮状态不可信。
    const historyAfter = await readTurnHistoryRaw(storyId);
    if (historyAfter !== historyBaseline) {
      return await this.failTurn(
        storyId,
        "committed history mutated during turn",
        playerInput,
      );
    }

    // 9. 成功：append history → 删除快照 → 返回 committed entry
    const turnId = crypto.randomUUID();
    const at = new Date().toISOString();
    const entry: TurnHistoryEntry = {
      turnId,
      at,
      input: historyInput,
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

    // 10. Issue 7：初始化任务成功提交时标记 story.md（Web 侧权威）。
    //     失败走 failTurn——回滚同时撤销 history entry，不会留下"已标记但未提交"状态。
    if (task === "init") {
      try {
        await markStoryInitialized(storyId);
      } catch (markErr) {
        return await this.failTurn(
          storyId,
          `mark initialized failed: ${markErr instanceof Error ? markErr.message : String(markErr)}`,
          playerInput,
        );
      }
    }

    await deleteSnapshot(storyId);
    // Issue 10：成功时返回净化后的交互状态（Web 唯一交互状态出口）。
    return { success: true, playerResponse, turn: entry, interaction: await readTurnInteraction(storyId) };
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
