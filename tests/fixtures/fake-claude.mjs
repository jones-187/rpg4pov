#!/usr/bin/env node
/**
 * fake-claude fixture（Issue 6 集成测试）。
 * 模拟 claude CLI 行为：读 stdin prompt，写 output.md + done.json，退出 0。
 * 支持环境变量 FAKE_CLAUDE_MODE 控制行为：
 *   - "success"（默认）：写 output + done，退出 0
 *   - "fail"：不写文件，退出 1
 *   - "timeout"：不写文件，不退出（由测试 abort）
 *   - "missing-output"：只写 done.json，不写 output.md
 *   - "assert-stdin"：断言 stdin 包含 playerInput/workspace/history 指令，
 *     成功写 output + done，失败写 stderr 并退出 1
 */
import { promises as fs } from "node:fs";
import path from "node:path";

/** 从 stdin 读取完整内容（模拟 claude -p 行为） */
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function main() {
  const mode = process.env.FAKE_CLAUDE_MODE ?? "success";
  const cwd = process.cwd();

  // 从 stdin 读取 prompt（与真实 claude -p 行为一致）
  const stdinData = await readStdin();

  if (mode === "timeout") {
    // 不退出，等 abort（用 setInterval 保持 event loop 活跃）
    await new Promise(() => {
      setInterval(() => {}, 1000);
    });
    return;
  }

  if (mode === "fail") {
    process.stderr.write("fake-claude simulated failure");
    process.exit(1);
  }

  // assert-stdin 模式：验证 stdin prompt 包含关键内容
  if (mode === "assert-stdin") {
    const errors = [];
    if (!stdinData.includes("推开木门")) {
      errors.push("stdin missing playerInput: '推开木门'");
    }
    if (!stdinData.includes("story.md")) {
      errors.push("stdin missing workspace directive: 'story.md'");
    }
    if (!stdinData.includes("history.jsonl")) {
      errors.push("stdin missing history.jsonl directive");
    }
    if (errors.length > 0) {
      process.stderr.write(`fake-claude stdin assertion failed:\n${errors.join("\n")}\nstdin was:\n${stdinData.slice(0, 500)}`);
      process.exit(1);
    }
  }

  const turnDir = path.join(cwd, "turn");
  await fs.mkdir(turnDir, { recursive: true });

  // Issue 8 链路测试：初始化任务（prompt 首行「初始化 agent」标识）。
  // 与真实 runner 契约一致：写实概念文档、canon 设定原文进 player.md、
  // 写开场 output（Issue 9 首行标题契约）+ done.json。
  if (stdinData.includes("初始化 agent")) {
    const settingMatch = stdinData.match(
      // 用户设定段之后紧跟骨架预注入段（P2：占位文件内容注入 prompt）
      /## 用户设定（canon，优先级最高）\n([\s\S]*?)\n## 已预注入的骨架文件/,
    );
    const setting = settingMatch ? settingMatch[1].trim() : "";
    await fs.writeFile(
      path.join(cwd, "world.md"),
      [
        "# 世界设定",
        "",
        "（fake-claude 初始化）浓雾封锁的海岬，废弃灯塔孤立在礁石上。",
        "隐藏事实：灯塔顶层住着守塔人失明的女儿（主角未知）。",
        "",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(cwd, "player.md"),
      ["# 主角", "", "## 用户设定（canon）", "", setting, "", "初始状态：健康。", ""].join("\n"),
    );
    await fs.writeFile(
      path.join(cwd, "rules.md"),
      ["# 规则", "", "（fake-claude 初始化）不确定判定交给随机工具。", ""].join("\n"),
    );
    await fs.mkdir(path.join(cwd, "actors"), { recursive: true });
    // Emotional Continuity：actor 卡四块情感结构（与 init prompt 契约一致）
    await fs.writeFile(
      path.join(cwd, "actors", "keeper.md"),
      [
        "# 守塔人",
        "",
        "表面：沉默的老人。",
        "私有记忆：他知道雾里有什么。",
        "",
        "## Emotional Core",
        "coreNeed: 有人在他看不住的那晚替灯续油。",
        "coreFear: 灯灭一次，雾里的东西就会上岸。",
        "vulnerability: 提起失明的女儿就守不住沉默。",
        "defensivePattern: 用守塔人的职责把话挡回去。",
        "approachPattern: 用灯塔的规矩和热茶留人。",
        "retreatPattern: 说到一半就转身核对灯油。",
        "",
        "## Relationship State: 主角",
        "surfaceRelationship: 新来的守塔学徒。",
        "privateMeaning: 也许能替他守住那盏灯的人。",
        "desiredPosition: 能在关键那晚留下的可靠帮手。",
        "perceivedPosition: 年轻、肯学，但还不知道灯意味着什么。",
        "approachImpulse: 学徒肯听规矩，肯问灯油，是好事。",
        "avoidanceImpulse: 说太多会把学徒吓跑，或招来雾里的注意。",
        "unresolvedQuestion: 这个学徒雾夜里会不会弃塔而逃。",
        "currentTension: 雾季要来了，而他一天比一天看不清。",
        "recentEvidence: （初始：暂无。）",
        "",
        "## Emotionally Salient Memories",
        "- event: 十二年前的雾夜，上一任守塔人下了塔。",
        "  meaning: 一次离开就是一条船。",
        "  impact: 他从此不再相信任何人能整夜守灯，直到证明相反。",
        "",
        "## Current Intent",
        "currentEmotion: 打量中的克制。",
        "emotionalTrigger: 学徒主动问起了灯油储备。",
        "emotionalConflict: 想教他全部，又怕他知道了真相就跑。",
        "immediateGoal: 试探学徒是否可靠。",
        "hiddenIntent: 确认雾季前能不能把塔交给他一晚。",
        "restraint: 直接交底会吓跑一个刚来的年轻人。",
        "behaviorStrategy: 用规矩和杂活观察他的耐心。",
        "voice: 短句、答一半、用守塔行话岔开关键问题。",
        "",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(turnDir, "output.md"),
      ["# 主角视窗", "", "（fake-claude 初始化开场）", "", "雾从海面漫上来，灯塔的门在你身后关上。", ""].join("\n"),
    );
    await fs.writeFile(
      path.join(turnDir, "interaction.json"),
      JSON.stringify({ mode: "continue", suggestions: [] }),
    );
    await fs.writeFile(
      path.join(turnDir, "done.json"),
      JSON.stringify({ status: "success", completedAt: new Date().toISOString() }),
    );
    process.exit(0);
  }

  if (mode === "missing-output") {
    await fs.writeFile(
      path.join(turnDir, "done.json"),
      JSON.stringify({ status: "success", completedAt: new Date().toISOString() }),
    );
    process.exit(0);
  }

  // success（含 assert-stdin 通过后也走此路径）
  await fs.writeFile(
    path.join(turnDir, "output.md"),
    "# 主角视窗\n\n（fake-claude 输出）\n\n回合执行完成。\n",
  );
  await fs.writeFile(
    path.join(turnDir, "interaction.json"),
    JSON.stringify({ mode: "continue", suggestions: [] }),
  );
  await fs.writeFile(
    path.join(turnDir, "done.json"),
    JSON.stringify({ status: "success", completedAt: new Date().toISOString() }),
  );
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(String(err));
  process.exit(1);
});
