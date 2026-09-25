import { describe, expect, it } from "vitest";
import {
  createPiResponseCollector,
  parseResponseJson,
  parseResponseStateUpdate,
  parseTurnResponse,
  parseResponseOutput,
} from "@/lib/pi-response";

const TURN_OUTPUT = "# 主角视窗\n\n我把门推开，雾从门缝里漫进来。";
const TURN_INTERACTION = { mode: "decision" as const, suggestions: ["问清楚"] };
const TURN_STATE_UPDATE = "=== NO CHANGES ===";

function turnResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "turn",
    output: TURN_OUTPUT,
    interaction: TURN_INTERACTION,
    stateUpdate: TURN_STATE_UPDATE,
    ...overrides,
  };
}

function messageEnd(
  content: unknown[],
  options: { role?: string; stopReason?: string } = {},
): string {
  return JSON.stringify({
    type: "message_end",
    message: {
      role: options.role ?? "assistant",
      stopReason: options.stopReason ?? "stop",
      content,
    },
  });
}

function textResponse(value: Record<string, unknown> = turnResponse()): string {
  return JSON.stringify(value);
}

describe("Pi response event collector", () => {
  it("取 assistant stop 的 text，忽略 thinking，不使用 partial", () => {
    const response = textResponse();
    const collector = createPiResponseCollector();

    collector.onLine(JSON.stringify({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        partial: { content: [{ type: "text", text: "不应被采用" }] },
      },
    }));
    collector.onLine(messageEnd([
      { type: "thinking", thinking: "隐藏的推理，不得泄漏" },
      { type: "text", text: response.slice(0, 20) },
      { type: "thinking", thinking: "另一段隐藏推理" },
      { type: "text", text: response.slice(20) },
    ]));

    expect(collector.finish("截断的 stdout 尾部")).toBe(response);
  });

  it("没有 callback 时从完整 stdout 逐行兜底解析 message_end", () => {
    const response = textResponse();
    const stdout = [
      "普通诊断行，不是响应",
      messageEnd([{ type: "thinking", thinking: "hidden" }, { type: "text", text: response }]),
      JSON.stringify({ type: "agent_end" }),
    ].join("\n");
    const collector = createPiResponseCollector();

    expect(collector.finish(stdout)).toBe(response);
  });

  it("不接受 stdout 中的裸自然语言小说", () => {
    const collector = createPiResponseCollector();

    expect(() => collector.finish("# 主角视窗\n\n这是模型口述的小说，没有 message_end。"))
      .toThrow();
  });

  it("拒绝不完整或截断的终止事件", () => {
    const collector = createPiResponseCollector();
    collector.onLine('{"type":"message_end","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"截断');

    expect(() => collector.finish(""))
      .toThrow();
  });

  it("callback 收到超过 64K 的完整终止事件时不依赖 stdout 尾部", () => {
    const response = textResponse({ stateUpdate: "x".repeat(70_000) });
    expect(response.length).toBeGreaterThan(64 * 1024);
    const collector = createPiResponseCollector();
    collector.onLine(messageEnd([{ type: "text", text: response }]));

    expect(collector.finish(response.slice(-64 * 1024))).toBe(response);
  });

  it("拒绝 toolCall 内容块", () => {
    const collector = createPiResponseCollector();
    collector.onLine(messageEnd([
      { type: "text", text: textResponse() },
      { type: "toolCall", name: "write", arguments: {} },
    ]));

    expect(() => collector.finish("")).toThrow();
  });

  it("拒绝非 stop 终止，不能由 stdout 中的合法事件绕过", () => {
    const collector = createPiResponseCollector();
    collector.onLine(messageEnd([{ type: "text", text: textResponse() }], { stopReason: "length" }));

    expect(() => collector.finish(messageEnd([{ type: "text", text: textResponse() }]))).toThrow("stopReason=length");
  });

  it("非正常终止只暴露受限 stopReason，不泄漏 errorMessage", () => {
    for (const stopReason of ["length", "error", "aborted", "toolUse", "unexpected"]) {
      const collector = createPiResponseCollector();
      const event = JSON.parse(messageEnd([{ type: "text", text: textResponse() }], { stopReason })) as Record<string, unknown>;
      (event.message as Record<string, unknown>).errorMessage = "网关秘密错误";
      collector.onLine(JSON.stringify(event));

      expect(() => collector.finish("")).toThrow(
        "stopReason=" + (["length", "error", "aborted", "toolUse"].includes(stopReason) ? stopReason : "unknown"),
      );
      expect(() => collector.finish("")).not.toThrow("网关秘密错误");
    }
  });

  it("拒绝多个 assistant 终止消息、无文本和超过 1MiB", () => {
    const response = textResponse();

    const duplicate = createPiResponseCollector();
    duplicate.onLine(messageEnd([{ type: "text", text: response }]));
    duplicate.onLine(messageEnd([{ type: "text", text: response }]));
    expect(() => duplicate.finish("")).toThrow();

    const empty = createPiResponseCollector();
    empty.onLine(messageEnd([{ type: "thinking", thinking: "only thinking" }]));
    expect(() => empty.finish("")).toThrow();

    const tooLarge = createPiResponseCollector();
    tooLarge.onLine(messageEnd([{ type: "text", text: "x".repeat(1_048_577) }]));
    expect(() => tooLarge.finish("")).toThrow();
  });
});

describe("parseTurnResponse", () => {
  it("导出的 parseResponseOutput 拒绝标题后空正文", () => {
    expect(parseResponseOutput(TURN_OUTPUT)).toBe(TURN_OUTPUT);
    expect(() => parseResponseOutput("# 主角视窗")).toThrow();
    expect(() => parseResponseOutput("# 主角视窗\n\n  \n")).toThrow();
  });

  it("解析裸 JSON turn", () => {
    expect(parseTurnResponse(textResponse())).toEqual({
      kind: "turn",
      output: TURN_OUTPUT,
      interaction: TURN_INTERACTION,
      stateUpdate: TURN_STATE_UPDATE,
    });
  });

  it("接受结构化 stateUpdate，并统一返回兼容 runner 的 JSON 字符串", () => {
    const stateUpdate = {
      sections: [{
        file: "world.md",
        ops: [{ kind: "append", text: "第一行\n第二行" }],
      }],
      rolls: [],
    };
    const serialized = JSON.stringify(stateUpdate);
    expect(parseResponseStateUpdate(stateUpdate)).toBe(serialized);
    expect(parseTurnResponse(textResponse(turnResponse({ stateUpdate })))).toEqual({
      kind: "turn",
      output: TURN_OUTPUT,
      interaction: TURN_INTERACTION,
      stateUpdate: serialized,
    });
    expect(() => parseResponseStateUpdate({ ...stateUpdate, extra: true })).toThrow();
  });

  it("解析完整单个 json 代码块，并拒绝前后杂文", () => {
    const fenced = `\n\`\`\`json\n${textResponse()}\n\`\`\`\n`;
    expect(parseTurnResponse(fenced)).toEqual({
      kind: "turn",
      output: TURN_OUTPUT,
      interaction: TURN_INTERACTION,
      stateUpdate: TURN_STATE_UPDATE,
    });
    expect(() => parseTurnResponse(`说明文字\n${textResponse()}`)).toThrow();
    expect(() => parseTurnResponse(`${textResponse()}\n谢谢`)).toThrow();
  });

  it("支持 roll-request 外壳但保留候选交给 bindTurnRolls", () => {
    const rolls = [{ rollId: "risk", candidates: [{ id: "yes", weight: 1 }, { id: "no", weight: 1 }] }];
    expect(parseTurnResponse(JSON.stringify({ kind: "roll-request", rolls }))).toEqual({
      kind: "roll-request",
      rolls,
    });
  });

  it("严格拒绝 turn 顶层未知字段和不合法交互，不默默降级", () => {
    expect(() => parseTurnResponse(textResponse({ debug: true }))).toThrow();
    expect(() => parseTurnResponse(textResponse({ interaction: { mode: "other", suggestions: [] } }))).toThrow();
    expect(() => parseTurnResponse(textResponse({ interaction: { mode: "decision", suggestions: [" "] } }))).toThrow();
    expect(() => parseTurnResponse(textResponse({ interaction: { mode: "decision", suggestions: ["x".repeat(121)] } }))).toThrow();
    expect(() => parseTurnResponse(textResponse({ interaction: { mode: "decision", suggestions: ["a", "b", "c", "d", "e"] } }))).toThrow();
  });

  it("校验 turn 输出、状态更新和 roll 数量边界", () => {
    expect(() => parseTurnResponse(textResponse({ output: "没有标题" }))).toThrow();
    expect(() => parseTurnResponse(textResponse({ output: "# 主角视窗\n\n" }))).toThrow();
    expect(() => parseTurnResponse(textResponse({ stateUpdate: "   " }))).toThrow();
    expect(() => parseTurnResponse(textResponse({ stateUpdate: "x".repeat(100_001) }))).toThrow();
    expect(() => parseTurnResponse(JSON.stringify({ kind: "roll-request", rolls: [] }))).toThrow();
    expect(() => parseTurnResponse(JSON.stringify({ kind: "roll-request", rolls: [1, 2, 3, 4, 5, 6, 7] }))).toThrow();
  });

  it("parseResponseJson 只接受完整 JSON 值，不吞掉前后杂文", () => {
    expect(parseResponseJson("{\"ok\":true}")).toEqual({ ok: true });
    expect(parseResponseJson("```json\n{\"ok\":true}\n```")).toEqual({ ok: true });
    expect(() => parseResponseJson("前言 {\"ok\":true}")).toThrow();
  });
});
