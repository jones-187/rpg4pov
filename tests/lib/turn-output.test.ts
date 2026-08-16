import { describe, it, expect } from "vitest";
import {
  validateTurnOutput,
  TURN_OUTPUT_HEADING,
  MAX_TURN_OUTPUT_CHARS,
} from "@/lib/turn-output";
import { TURN_OUTPUT_PLACEHOLDER } from "@/lib/workspace";

/**
 * Issue 9：主角视窗输出校验（basic output validation，arch-prd US 45 / Decision 34）。
 * 粗判原则：只拒绝"明显不合规"，不做语义级审查（更严格校验是 P1）。
 */
describe("validateTurnOutput", () => {
  // --- 存在性（Issue 4 既有语义，reason 保持不变） ---

  it("null content（output.md 不存在）→ output missing or empty", () => {
    expect(validateTurnOutput(null)).toBe("output missing or empty");
  });

  it("空/纯空白内容 → output missing or empty", () => {
    expect(validateTurnOutput("")).toBe("output missing or empty");
    expect(validateTurnOutput("   \n\n  ")).toBe("output missing or empty");
  });

  it("createStory 占位原文 → output missing or empty（runner 未写 output）", () => {
    expect(validateTurnOutput(TURN_OUTPUT_PLACEHOLDER)).toBe("output missing or empty");
  });

  // --- 首行标题契约 ---

  it("合规：首行恰为「# 主角视窗」", () => {
    expect(validateTurnOutput("# 主角视窗\n\n雨落在窗上。")).toBeNull();
  });

  it("合规：标题前有空白行/标题后有尾随空格（按第一个非空行 trim 判断）", () => {
    expect(validateTurnOutput("\n\n# 主角视窗  \n\n雨落在窗上。")).toBeNull();
  });

  it("不合规：没有标题", () => {
    const problem = validateTurnOutput("夜色深沉，雨落在窗上。");
    expect(problem).toContain("output format invalid");
    expect(problem).toContain(TURN_OUTPUT_HEADING);
  });

  it("不合规：标题写法不对（二级标题/改写标题）", () => {
    expect(validateTurnOutput("## 主角视窗\n\n雨落在窗上。")).toContain("output format invalid");
    expect(validateTurnOutput("# 本回合输出\n\n雨落在窗上。")).toContain("output format invalid");
  });

  it("不合规：标题出现在正文中间而非首行", () => {
    expect(validateTurnOutput("雨落在窗上。\n\n# 主角视窗")).toContain("output format invalid");
  });

  // --- 长度上限（只拦失控输出） ---

  it("合规：长度恰好等于上限", () => {
    const heading = `# 主角视窗\n\n`;
    const content = heading + "雨".repeat(MAX_TURN_OUTPUT_CHARS - heading.length);
    expect(content.length).toBe(MAX_TURN_OUTPUT_CHARS);
    expect(validateTurnOutput(content)).toBeNull();
  });

  it("不合规：超过长度上限", () => {
    const content = `# 主角视窗\n\n` + "雨".repeat(MAX_TURN_OUTPUT_CHARS);
    expect(content.length).toBeGreaterThan(MAX_TURN_OUTPUT_CHARS);
    const problem = validateTurnOutput(content);
    expect(problem).toContain("output format invalid");
    expect(problem).toContain("exceeds");
  });

  // --- 明显非叙事内容 ---

  it("不合规：正文是完整 JSON 对象/数组（agent 把 CLI 结构化输出糊进 output）", () => {
    expect(validateTurnOutput('# 主角视窗\n\n{"result":"ok","turn":1}')).toContain(
      "output format invalid",
    );
    expect(validateTurnOutput('# 主角视窗\n\n[{"npc":"店主"}]')).toContain(
      "output format invalid",
    );
  });

  it("合规：正文以 { 开头但不是合法 JSON（只拒绝确凿的 JSON 转储）", () => {
    expect(validateTurnOutput("# 主角视窗\n\n{他推开门，雨声灌了进来。")).toBeNull();
  });

  it("合规：叙事中间出现 JSON 片段（只有正文整体是 JSON 才拒绝）", () => {
    expect(validateTurnOutput('# 主角视窗\n\n你看到一张字条，上面写着 {"hint": "..."} 的字样。')).toBeNull();
  });

  // --- 随机日志指纹（内部日志不外泄的确定性判据） ---

  const rollLine = JSON.stringify({
    at: "2026-08-16T00:00:00.000Z",
    storyId: "00000000-0000-4000-8000-000000000000",
    rollId: "perception-check",
    type: "roll-choice",
    candidates: [{ id: "success", weight: 25 }],
    selectedId: "success",
    randomSource: "crypto",
    sample: 0.42,
  });

  it("不合规：random-rolls.jsonl 的行被逐字抄进 output", () => {
    const content = `# 主角视窗\n\n${rollLine}\n\n你环顾四周。`;
    expect(validateTurnOutput(content, [rollLine])).toContain("random log");
  });

  it("合规：random log 存在但未被抄进 output（正常路径，无 false positive）", () => {
    expect(validateTurnOutput("# 主角视窗\n\n你环顾四周，一切安静。", [rollLine])).toBeNull();
  });

  it("合规：randomRollLines 含空行/空白行时忽略", () => {
    expect(
      validateTurnOutput("# 主角视窗\n\n你环顾四周，一切安静。", ["", "   "]),
    ).toBeNull();
  });
});

// --- Issue 12 扩展：interaction metadata 外泄指纹 ---

describe("validateTurnOutput extra leak fingerprints (Issue 12)", () => {
  const heading = "# 主角视窗\n\n";
  const interactionLine = JSON.stringify({ mode: "decision", suggestions: ["开口"] });

  it("rejects output containing interaction.json raw line verbatim", () => {
    expect(validateTurnOutput(heading + "她停下了手里的活。\n" + interactionLine, [], [interactionLine])).toContain(
      "leaked",
    );
  });

  it("passes when interaction fingerprint not present", () => {
    expect(validateTurnOutput(heading + "她抬起头。", [], [interactionLine])).toBeNull();
  });
});
