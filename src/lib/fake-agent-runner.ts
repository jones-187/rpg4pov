import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentRunner, TurnRequest, TurnResult } from "./agent-runner";
import { TURN_OUTPUT_HEADING } from "./turn-output";

/**
 * Fake Agent Runner — Issue 3 验证用实现。
 * 不接入真实大模型，读取 playerInput 后生成固定格式输出。
 * 只写 turn/output.md 和 turn/done.json，不碰其他 workspace 文件。
 * 是临时验证组件，非永久产品运行时。
 *
 * Issue 4：honors TurnRequest.signal（入口 throwIfAborted）。
 * Fake Agent 瞬时完成，正常路径永不触发 abort；但 contract 要求响应 signal，
 * 不响应会退化为 Promise.race-only 的幽灵写入风险。
 *
 * Issue 7：task="init" 时写一套固定初始化产物
 * （world/player/rules/actors + 开场 output + done.json），
 * 用户设定原文写入 player.md（fake 层验证 canon 保留）。
 */
export class FakeAgentRunner implements AgentRunner {
  async runTurn(req: TurnRequest): Promise<TurnResult> {
    // honor contract：入口检查 abort（Fake Agent 瞬时，此处正常不触发）
    req.signal.throwIfAborted();

    if (req.task === "init") {
      return this.runInit(req);
    }

    const turnDir = path.join(req.workspaceDir, "turn");

    const output = [
      TURN_OUTPUT_HEADING,
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
    // Issue 10：固定交互状态——连续演出阶段、无建议
    await fs.writeFile(
      path.join(turnDir, "interaction.json"),
      JSON.stringify({ mode: "continue", suggestions: [] }),
    );
    await fs.writeFile(
      path.join(turnDir, "done.json"),
      JSON.stringify({
        status: "success",
        completedAt: new Date().toISOString(),
      }),
    );

    return { success: true };
  }

  /** Issue 7：固定初始化产物。设定原文保留在 player.md，其余为占位内容。 */
  private async runInit(req: TurnRequest): Promise<TurnResult> {
    const dir = req.workspaceDir;

    // 写文件前检查 abort（与 turn 路径一致的 contract 演示）
    req.signal.throwIfAborted();

    await fs.writeFile(
      path.join(dir, "world.md"),
      [
        "# 世界设定",
        "",
        "（Fake Agent 初始化）小场景：一间深夜营业的路边旅店，雨下个不停。",
        "隐藏事实：店主拖欠着本地走私团伙的债（主角未知）。",
        "",
      ].join("\n"),
    );
    // canon 保留：用户设定原文进入主角角色卡
    await fs.writeFile(
      path.join(dir, "player.md"),
      ["# 主角", "", "## 用户设定（canon）", "", req.playerInput, "", "初始状态：健康，略有倦意。", ""].join("\n"),
    );
    await fs.writeFile(
      path.join(dir, "rules.md"),
      ["# 规则", "", "（Fake Agent 初始化）基础规则：不确定的判定交给随机工具。", ""].join("\n"),
    );
    await fs.writeFile(
      path.join(dir, "actors", "shopkeeper.md"),
      ["# 店主 玛尔塔", "", "表面：疲惫的中年妇人，话不多。", "私有记忆：她认得门外那个斗篷人的脸。", ""].join("\n"),
    );

    const turnDir = path.join(dir, "turn");
    await fs.writeFile(
      path.join(turnDir, "output.md"),
      [
        TURN_OUTPUT_HEADING,
        "",
        "（Fake Agent 初始化开场）",
        "",
        "雨夜的旅店里，壁炉的火光摇曳。你找了个角落的位置坐下，店主从柜台后看了你一眼。",
        "",
      ].join("\n"),
    );
    // Issue 10：开场交互状态——连续演出阶段、无建议
    await fs.writeFile(
      path.join(turnDir, "interaction.json"),
      JSON.stringify({ mode: "continue", suggestions: [] }),
    );
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
