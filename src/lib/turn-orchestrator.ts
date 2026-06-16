import type { AgentRunner, TurnResult } from "./agent-runner";
import {
  clearTurnDone,
  readTurnDone,
  readTurnOutput,
  resolveWorkspaceDir,
  writeTurnInput,
} from "./workspace";

/**
 * 回合编排结果。Orchestrator → Route。
 * playerResponse 从 turn/output.md 读取，不是 runner 返回值。
 */
export interface TurnOutcome {
  success: boolean;
  playerResponse: string | null;
  error?: string;
}

/**
 * 回合生命周期编排器。
 * 持有 AgentRunner 实例，对回合内的所有失败负责。
 * 不直接 fs，通过 workspace.ts 读写。
 */
export class TurnOrchestrator {
  constructor(private runner: AgentRunner) {}

  async executeTurn(storyId: string, playerInput: string): Promise<TurnOutcome> {
    // 1. 清理上回合 done.json
    await clearTurnDone(storyId);

    // 2. 写入主角输入
    await writeTurnInput(storyId, playerInput);

    // 3. 获取 workspace 绝对路径，构造请求
    const workspaceDir = resolveWorkspaceDir(storyId);
    const req = { storyId, workspaceDir, playerInput };

    // 4. 调用 runner（捕获异常，转为失败）
    let result: TurnResult;
    try {
      result = await this.runner.runTurn(req);
    } catch {
      result = { success: false, error: "runner crashed" };
    }

    // 5. 检查磁盘权威状态：done.json 必须存在且 status=success
    const done = await readTurnDone(storyId);
    if (!done || done.status !== "success") {
      return {
        success: false,
        playerResponse: null,
        error: result.error ?? "done marker missing",
      };
    }

    // 6. 检查 output.md 必须存在且非空
    const playerResponse = await readTurnOutput(storyId);
    if (!playerResponse || playerResponse.trim() === "") {
      return {
        success: false,
        playerResponse: null,
        error: "output missing or empty",
      };
    }

    // 7. 成功：返回从文件读取的主角可见输出
    return { success: true, playerResponse };
  }
}
