#!/usr/bin/env node
/**
 * Fake Pi CLI for the real PiRunner/API chain tests. The prompt is the final
 * argv value (PiRunner deliberately keeps stdin empty). Ordinary no-tools
 * turns return a message_end response; init phases retain their write fixture.
 */
import { promises as fs, writeSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const prompt = args.at(-1) ?? "";
const systemPrompt = args.join("\n");
const cwd = process.cwd();
const turnDir = path.join(cwd, "turn");
const noTools = args.includes("--no-tools");

function emitResponse(value) {
  writeSync(1, `${JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: JSON.stringify(value) }],
    },
  })}\n`);
}

if (noTools) {
  if (systemPrompt.includes("本实验路径的产物")) {
    emitResponse({
      kind: "scene",
      visibleEvents: ["守塔人把灯油放在桌上，指向窗外。"],
      publicScene: {
        time: "第一天清晨",
        location: "灯塔门口",
        narrativeVoice: "第一人称限知",
        knownFacts: ["灯快熄了"],
        visibleActors: [{ name: "守塔人", appearance: "旧雨衣", voice: "短句" }],
      },
      stateUpdate: {
        sections: [{
          file: "world.md",
          ops: [{ kind: "append", text: "守塔人已将灯油放在桌上。" }],
        }],
        rolls: [],
      },
      interaction: { mode: "decision", suggestions: ["看向窗外"] },
    });
  } else if (systemPrompt.includes("主角限知叙事作者")) {
    emitResponse({
      kind: "render",
      output: "# 主角视窗\n\n守塔人把灯油放在桌上，指向窗外。我顺着他的手看过去。\n",
    });
  } else {
    emitResponse({
      kind: "turn",
      output: "# 主角视窗\n\n我沿着湿滑的石阶向上，守塔人没有阻拦，只把钥匙收回掌心。\n",
      interaction: { mode: "decision", suggestions: ["追问钥匙的来历"] },
      stateUpdate: { sections: [], rolls: [] },
    });
  }
} else if (systemPrompt.includes("Phase 1")) {
  await fs.mkdir(turnDir, { recursive: true });

  const setting = prompt.match(/## 用户设定（canon，优先级最高）\n([\s\S]*?)\n\n## 初始化骨架文件/)?.[1]?.trim() ?? "";
  const bundle = [
    "=== FILE: world.md ===",
    "# 世界设定",
    "",
    "雾中的废弃灯塔，潮水会在黎明前淹没礁桥。",
    "隐藏事实：灯塔地下藏着一枚会回应潮声的旧钥匙（主角未知）。",
    "=== FILE: player.md ===",
    "# 主角",
    "",
    "## 用户设定（canon）",
    setting,
    "",
    "## Public Scene",
    JSON.stringify({
      time: "第一天清晨",
      location: "灯塔门口",
      narrativeVoice: "第一人称限知",
      knownFacts: ["灯快熄了"],
      visibleActors: [{ name: "守塔人", appearance: "旧雨衣", voice: "短句" }],
    }),
    "",
    "## Protagonist Core",
    "narrativeVoice: 第一人称限知，句子克制但有具体心理反应。",
    "temperament: 谨慎而有好奇心。",
    "emotionalExpression: 先观察再承认情绪。",
    "conflictStyle: 先询问证据，不轻易退让。",
    "relationshipStyle: 尊重边界，靠行动建立信任。",
    "humorStyle: 偶尔自嘲。",
    "initiative: 会主动查找低风险线索。",
    "moralBoundaries: 不牺牲无辜者。",
    "speechPatterns: 短句，必要时追问。",
    "avoidExpressions: 不替自己做重大承诺。",
    "",
    "## Player Agency",
    "重大关系、道德和不可逆决定必须交还玩家。",
    "=== FILE: rules.md ===",
    "# 规则",
    "",
    "小场景以有限地点推进；不确定结果由服务端随机工具约束。",
    "=== FILE: actors/keeper.md ===",
    "# 守塔人",
    "",
    "## Emotional Core",
    "coreNeed: 确认有人愿意留下守灯。",
    "coreFear: 灯灭后雾里的东西上岸。",
    "vulnerability: 被提醒自己已经看不清灯芯。",
    "defensivePattern: 用规矩挡住追问。",
    "approachPattern: 递来热茶并分享一条工作建议。",
    "retreatPattern: 转身检查灯油，恢复职责距离。",
    "",
    "## Relationship State: 主角",
    "surfaceRelationship: 新来的学徒。",
    "privateMeaning: 可能接替自己的人。",
    "desiredPosition: 可靠的守灯搭档。",
    "perceivedPosition: 愿意学习但仍不了解危险。",
    "approachImpulse: 学徒主动询问灯油。",
    "avoidanceImpulse: 说出秘密可能吓走学徒。",
    "unresolvedQuestion: 学徒会否在雾潮前留下。",
    "currentTension: 潮水上涨而灯芯将尽。",
    "recentEvidence: （初始暂无。）",
    "",
    "## Emotionally Salient Memories",
    "- event: 上一任守塔人在雾夜离开。",
    "  meaning: 离开的人不会回来。",
    "  impact: 他把留下视为需要被证明的承诺。",
    "",
    "## Current Intent",
    "currentEmotion: 克制的警觉。",
    "emotionalTrigger: 学徒问起地下室的钥匙。",
    "emotionalConflict: 想教会学徒又怕他触碰危险。",
    "immediateGoal: 试探学徒是否能守住规矩。",
    "hiddenIntent: 确认学徒是否能替自己守灯。",
    "restraint: 直接交底会让学徒逃走。",
    "behaviorStrategy: 用工作指令观察耐心。",
    "voice: 短句，答一半，关键处停顿。",
  ].join("\n");
  await fs.writeFile(path.join(turnDir, "state-update.md"), bundle);
} else if (systemPrompt.includes("Phase 2")) {
  await fs.writeFile(path.join(turnDir, "output.md"), "# 主角视窗\n\n雾从门缝里漫进来，灯塔的铜铃忽然响了一声。\n");
  await fs.writeFile(path.join(turnDir, "interaction.json"), JSON.stringify({ mode: "continue", suggestions: [] }));
} else if (systemPrompt.includes("本实验路径的产物")) {
  await fs.writeFile(path.join(turnDir, "scene-plan.json"), JSON.stringify({
    visibleEvents: ["守塔人把灯油放在桌上，指向窗外。"],
    stateUpdate: "=== FILE: world.md ===\nAPPEND: 守塔人已将灯油放在桌上。",
    interaction: { mode: "decision", suggestions: ["看向窗外"] },
  }));
} else if (systemPrompt.includes("主角限知叙事作者")) {
  await fs.writeFile(path.join(turnDir, "output.md"), "# 主角视窗\n\n守塔人把灯油放在桌上，指向窗外。我顺着他的手看过去。\n");
} else {
  await fs.writeFile(path.join(turnDir, "output.md"), "# 主角视窗\n\n我沿着湿滑的石阶向上，守塔人没有阻拦，只把钥匙收回掌心。\n");
  await fs.writeFile(path.join(turnDir, "interaction.json"), JSON.stringify({ mode: "decision", suggestions: ["追问钥匙的来历"] }));
  await fs.writeFile(path.join(turnDir, "state-update.md"), "=== FILE: world.md ===\nAPPEND: ## 当前进展\n潮声在地下室门后变得清晰。\n");
}
