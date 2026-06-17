import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentRunner, TurnRequest, TurnResult } from "./agent-runner";

/**
 * Fake Agent Runner — Issue 3 验证用实现。
 * 不接入真实大模型，读取 playerInput 后生成固定格式输出。
 * 只写 turn/output.md 和 turn/done.json，不碰其他 workspace 文件。
 * 是临时验证组件，非永久产品运行时。
 *
 * Issue 4：honors TurnRequest.signal（入口 throwIfAborted）。
 * Fake Agent 瞬时完成，正常路径永不触发 abort；但 contract 要求响应 signal，
 * 不响应会退化为 Promise.race-only 的幽灵写入风险。
 */
export class FakeAgentRunner implements AgentRunner {
  async runTurn(req: TurnRequest): Promise<TurnResult> {
    // honor contract：入口检查 abort（Fake Agent 瞬时，此处正常不触发）
    req.signal.throwIfAborted();

    const turnDir = path.join(req.workspaceDir, "turn");

    const output = [
      "# 主角视窗",
      "",
      "（Fake Agent 固定输出）",
      "",
      `你选择了：${req.playerInput}`,
      "",
      "周围一切安静。没有特别的事情发生。",
      "",
    ].join("\n");

    // 写文件前再查一次 abort（演示 contract；真实 runner 在子进程层响应）
    req.signal.throwIfAborted();

    await fs.writeFile(path.join(turnDir, "output.md"), output);
    await fs.writeFile(
      path.join(turnDir, "done.json"),
      JSON.stringify({
        status: "success",
        completedAt: new Date().toISOString(),
      }),
    );

    return { success: true };
  }
}
