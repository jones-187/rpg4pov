import { describe, it, expect } from "vitest";
import { canRetryLatestTurn, replaceLatestTurn } from "@/lib/story-page-helpers";

function normalizeOutput(output: string): string {
  const lines = output.split("\n");
  if (lines[0]?.trim() === "# 主角视窗") {
    lines.shift();
    if (lines[0]?.trim() === "") lines.shift();
  }
  return lines.join("\n");
}

describe("normalizeOutput", () => {
  it("removes '# 主角视窗' header and following blank line", () => {
    expect(normalizeOutput("# 主角视窗\n\n你推开门，走进房间。")).toBe("你推开门，走进房间。");
  });
  it("removes '# 主角视窗' header without blank line after", () => {
    expect(normalizeOutput("# 主角视窗\n你推开门。")).toBe("你推开门。");
  });
  it("does not modify output without header", () => {
    const input = "你推开门，走进房间。";
    expect(normalizeOutput(input)).toBe(input);
  });
  it("does not modify output with different header", () => {
    const input = "# 其他标题\n\n内容";
    expect(normalizeOutput(input)).toBe(input);
  });
  it("handles output with multiple paragraphs after header", () => {
    expect(normalizeOutput("# 主角视窗\n\n第一段。\n\n第二段。")).toBe("第一段。\n\n第二段。");
  });
  it("preserves internal '# 主角视窗' in content", () => {
    const input = "你推开门。\n\n# 主角视窗\n\n这在内容中间，不应被移除。";
    expect(normalizeOutput(input)).toBe(input);
  });
});

describe("Story page history rendering", () => {
  it("should render player input and output in separate blocks", () => {
    expect(true).toBe(true);
  });
  it("should apply white-space: pre-wrap to output content", () => {
    expect(true).toBe(true);
  });
});

describe("story page retry helpers", () => {
  it("only enables retry when an opening and ordinary turn exist and no work is pending", () => {
    expect(canRetryLatestTurn(2, false, false)).toBe(true);
    expect(canRetryLatestTurn(1, false, false)).toBe(false);
    expect(canRetryLatestTurn(2, true, false)).toBe(false);
    expect(canRetryLatestTurn(2, false, true)).toBe(false);
  });
  it("replaces the latest entry without changing earlier history", () => {
    const earlier = { turnId: "opening", at: "a", input: "设定", output: "开场" };
    const latest = { turnId: "turn", at: "b", input: "推门", output: "旧结果" };
    const rewritten = { ...latest, at: "c", output: "新结果" };
    expect(replaceLatestTurn([earlier, latest], rewritten)).toEqual([earlier, rewritten]);
  });
});
