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
 * Emotional Continuity：init 产物 actor 卡含 Emotional Core / Relationship
 * State / Emotionally Salient Memories / Current Intent 四块结构（fake 层验证落盘）。
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
    // 情感连续性结构（Emotional Continuity）：Emotional Core / Relationship State /
    // Emotionally Salient Memories / Current Intent 四块，供回合 agent 读取更新。
    await fs.writeFile(
      path.join(dir, "actors", "shopkeeper.md"),
      [
        "# 店主 玛尔塔",
        "",
        "表面：疲惫的中年妇人，话不多。",
        "私有记忆：她认得门外那个斗篷人的脸。",
        "",
        "## Emotional Core",
        "coreNeed: 确认女儿能安全离开这片边境。",
        "coreFear: 走私团伙的债永远还不清，最后拿人抵债。",
        "vulnerability: 任何威胁到女儿的名字都会让她失控。",
        "defensivePattern: 用沉默和疲惫当掩护，不解释自己的异常。",
        "approachPattern: 通过多添一份汤、留一盏灯这类小事表达在意。",
        "retreatPattern: 一旦被问紧就转身擦杯子，退回店主身份里。",
        "",
        "## Relationship State: 主角",
        "surfaceRelationship: 刚入住一晚的陌生旅客。",
        "privateMeaning: 一个可能的旁观者，也可能是还债的机会。",
        "desiredPosition: 希望他是懂规矩、付现钱、不多问的过客。",
        "perceivedPosition: 他在观察这间店，程度不明。",
        "approachImpulse: 他看起来手头不紧，今晚的房钱是实在的。",
        "avoidanceImpulse: 他若和门外那伙人有关系，靠近就是引火烧身。",
        "unresolvedQuestion: 这个年轻人到底为什么在雨夜来这里。",
        "currentTension: 债主的人就在街对面，而店里只有这一个客人。",
        "recentEvidence: （初始：暂无。）",
        "",
        "## Emotionally Salient Memories",
        "- event: 三天前债主当面摔了她的账本。",
        "  meaning: 期限不是吓唬人的。",
        "  impact: 她开始在夜里盘算把店押出去。",
        "",
        "## Current Intent",
        "currentEmotion: 压着疲惫的警觉。",
        "emotionalTrigger: 斗篷人今早又出现在街对面。",
        "emotionalConflict: 想让客人尽快离开避嫌，又需要今晚的房钱。",
        "immediateGoal: 让主角待在堂内、别去打听门外的事。",
        "hiddenIntent: 摸清主角是不是那伙人带来的眼线。",
        "restraint: 直接盘问会暴露她在怕什么。",
        "behaviorStrategy: 用店主的日常招呼观察他的反应。",
        "voice: 短句、不主动接话、把关键信息藏在抱怨里。",
        "",
      ].join("\n"),
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
