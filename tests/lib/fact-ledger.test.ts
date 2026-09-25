import { describe, expect, it } from "vitest";
import {
  FACT_LEDGER_MAX_EVENTS,
  FACT_LEDGER_MAX_LIST_ITEMS,
  FACT_LEDGER_MAX_STRING_LENGTH,
  parseFactLedger,
  renderFactLedger,
} from "@/lib/fact-ledger";

const validLedger = {
  version: "1",
  events: [
    {
      id: "public-1",
      text: "主楼东门在午钟后对所有人开放。",
      source: "player",
      time: "次日午钟后",
      location: "主楼东门",
      witnesses: ["主角", "白临"],
      visibility: "public",
      causedBy: [],
    },
    {
      id: "private-1",
      text: "主角独自看见东廊门缝里的蓝蜡纸片。",
      source: "player",
      time: "次日午后",
      location: "旧档案馆东廊",
      witnesses: ["主角"],
      visibility: "private",
      causedBy: [],
    },
    {
      id: "derived-1",
      text: "白临没有看见主角查看东廊门缝。",
      source: "system",
      time: "次日午后",
      location: "旧档案馆东廊",
      witnesses: [],
      visibility: "public",
      causedBy: ["private-1"],
    },
  ],
};

describe("fact ledger", () => {
  it("parses and renders a valid ledger", () => {
    const ledger = parseFactLedger(validLedger);
    expect(ledger.events).toHaveLength(3);
    const rendered = renderFactLedger(ledger);
    expect(rendered).toContain("id=public-1");
    expect(rendered).toContain("text=主楼东门在午钟后对所有人开放。");
    expect(rendered).toContain("source=player");
    expect(rendered).toContain("time=次日午钟后");
    expect(rendered).toContain("location=主楼东门");
    expect(rendered).toContain("witnesses=主角 | 白临");
    expect(rendered).toContain("visibility=public");
    expect(rendered).toContain("causedBy=none");
  });

  it("hides private facts and their derived events", () => {
    const rendered = renderFactLedger(parseFactLedger(validLedger));

    expect(rendered).toContain("知识边界=");
    expect(rendered).toContain("仅以下角色掌握未公开事实：主角；");
    expect(rendered).toContain("其他角色不得表现出知道该事实，也不得用相关话题暗示。");
    expect(rendered.match(/知识边界=/g)).toHaveLength(1);

    expect(rendered).not.toContain("private-1");
    expect(rendered).not.toContain("derived-1");
    expect(rendered).not.toContain("蓝蜡纸片");
    expect(rendered).not.toContain("旧档案馆东廊");
    expect(rendered).not.toContain("次日午后");
    expect(rendered).not.toContain("白临没有看见");
  });

  it("inherits knowledge holders through indirect private dependencies", () => {
    const ledger = parseFactLedger({
      version: "1",
      events: [
        ...validLedger.events,
        {
          id: "indirect-1",
          text: "东廊随后保持关闭。",
          source: "system",
          time: "次日傍晚",
          location: "东廊",
          witnesses: [],
          visibility: "public",
          causedBy: ["derived-1"],
        },
      ],
    });
    const rendered = renderFactLedger(ledger);
    expect(rendered).toContain("仅以下角色掌握未公开事实：主角；");
    expect(rendered).not.toContain("indirect-1");
    expect(rendered).not.toContain("东廊随后保持关闭");
  });

  it("does not inherit witnesses from unrelated public causes", () => {
    const ledger = parseFactLedger({
      version: "1",
      events: [
        ...validLedger.events,
        {
          id: "mixed-1",
          text: "公开与私密原因共同产生的结果。",
          source: "system",
          time: "次日傍晚",
          location: "东廊",
          witnesses: [],
          visibility: "public",
          causedBy: ["public-1", "private-1"],
        },
      ],
    });
    const rendered = renderFactLedger(ledger);
    expect(rendered).toContain("仅以下角色掌握未公开事实：主角；");
    expect(rendered).not.toContain("未公开事实：主角、白临");
    expect(rendered).not.toContain("mixed-1");
  });

  it("rejects duplicate event ids", () => {
    const invalid = {
      ...validLedger,
      events: [validLedger.events[0], { ...validLedger.events[0] }],
    };
    expect(() => parseFactLedger(invalid)).toThrow(/duplicate event id public-1/);
  });

  it("rejects causedBy references to later or unknown events", () => {
    const invalid = {
      ...validLedger,
      events: [
        { ...validLedger.events[0], id: "e2", causedBy: ["e1"] },
      ],
    };
    expect(() => parseFactLedger(invalid)).toThrow(/later or unknown event e1/);
  });

  it("requires a witness for private events", () => {
    const invalid = {
      ...validLedger,
      events: [{ ...validLedger.events[1], witnesses: [] }],
    };
    expect(() => parseFactLedger(invalid)).toThrow(/must have at least one witness/);
  });

  it("rejects invalid source, visibility, and extra fields", () => {
    const invalid = {
      ...validLedger,
      events: [{ ...validLedger.events[0], source: "npc" }],
    };
    expect(() => parseFactLedger(invalid)).toThrow(/source must be one of/);

    const invalidVisibility = {
      ...validLedger,
      events: [{ ...validLedger.events[0], visibility: "secret" }],
    };
    expect(() => parseFactLedger(invalidVisibility)).toThrow(/visibility must be one of/);

    const invalidExtra = { ...validLedger, extra: 1 };
    expect(() => parseFactLedger(invalidExtra)).toThrow(/unexpected fields/);
  });

  it("enforces size limits without semantic inference", () => {
    const tooManyEvents = {
      version: "1",
      events: Array.from({ length: FACT_LEDGER_MAX_EVENTS + 1 }, (_, i) => ({
        ...validLedger.events[0],
        id: `e${i}`,
      })),
    };
    expect(() => parseFactLedger(tooManyEvents)).toThrow(new RegExp(`events exceed ${FACT_LEDGER_MAX_EVENTS}`));

    const tooLong = "x".repeat(FACT_LEDGER_MAX_STRING_LENGTH + 1);
    expect(() => parseFactLedger({
      ...validLedger,
      events: [{ ...validLedger.events[0], text: tooLong }],
    })).toThrow(new RegExp(`text exceeds ${FACT_LEDGER_MAX_STRING_LENGTH} characters`));

    const tooManyWitnesses = Array.from({ length: FACT_LEDGER_MAX_LIST_ITEMS + 1 }, (_, i) => `w${i}`);
    expect(() => parseFactLedger({
      ...validLedger,
      events: [{ ...validLedger.events[0], witnesses: tooManyWitnesses }],
    })).toThrow(new RegExp(`witnesses exceeds ${FACT_LEDGER_MAX_LIST_ITEMS} items`));
  });
});
