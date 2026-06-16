import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentRunner, TurnRequest, TurnResult } from "./agent-runner";

/**
 * Fake Agent Runner — Issue 3 验证用实现。
 * 不接入真实大模型，读取 playerInput 后生成固定格式输出。
 * 只写 turn/output.md 和 turn/done.json，不碰其他 workspace 文件。
 * 是临时验证组件，非永久产品运行时。
 */
export class FakeAgentRunner implements AgentRunner {
  async runTurn(req: TurnRequest): Promise<TurnResult> {
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
