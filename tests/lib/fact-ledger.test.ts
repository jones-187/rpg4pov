import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyFactLedgerUpdate,
  FACT_LEDGER_MAX_EVENTS,
  FACT_LEDGER_MAX_KNOWLEDGE_BOUNDARIES,
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

const replayPath = path.resolve(
  __dirname,
  "../fixtures/public-continuity-card-replay.json",
);

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

  it("parses explicit knowledge boundaries and keeps old ledgers compatible", () => {
    const legacy = parseFactLedger(validLedger);
    expect(legacy.knowledgeBoundaries).toEqual([]);

    const ledger = parseFactLedger({
      ...validLedger,
      knowledgeBoundaries: [{ id: "boundary-1", holders: ["白临", "主角"] }],
    });
    expect(ledger.knowledgeBoundaries).toEqual([
      { id: "boundary-1", holders: ["主角", "白临"] },
    ]);
  });

  it("renders explicit boundaries abstractly and deduplicates identical holders", () => {
    const sameHolders = parseFactLedger({
      ...validLedger,
      knowledgeBoundaries: [{ id: "boundary-1", holders: ["主角"] }],
    });
    const sameRendered = renderFactLedger(sameHolders);
    expect(sameRendered.match(/知识边界=/g)).toHaveLength(1);
    expect(sameRendered).not.toContain("boundary-1");

    const distinctHolders = parseFactLedger({
      ...validLedger,
      knowledgeBoundaries: [{ id: "boundary-2", holders: ["白临"] }],
    });
    const distinctRendered = renderFactLedger(distinctHolders);
    expect(distinctRendered.match(/知识边界=/g)).toHaveLength(2);
    expect(distinctRendered).toContain("仅以下角色掌握未公开事实：主角；");
    expect(distinctRendered).toContain("仅以下角色掌握未公开事实：白临；");
  });

  it("rejects invalid explicit knowledge boundaries", () => {
    const conflictingId = {
      ...validLedger,
      knowledgeBoundaries: [{ id: "public-1", holders: ["主角"] }],
    };
    expect(() => parseFactLedger(conflictingId)).toThrow(/conflicts with event id public-1/);

    const emptyHolders = {
      ...validLedger,
      knowledgeBoundaries: [{ id: "boundary-1", holders: [] }],
    };
    expect(() => parseFactLedger(emptyHolders)).toThrow(/holders must have at least one holder/);

    const duplicateHolders = {
      ...validLedger,
      knowledgeBoundaries: [{ id: "boundary-1", holders: ["主角", "主角"] }],
    };
    expect(() => parseFactLedger(duplicateHolders)).toThrow(/holders contains duplicate values/);

    const invalidBoundaries = { ...validLedger, knowledgeBoundaries: null };
    expect(() => parseFactLedger(invalidBoundaries)).toThrow(/knowledgeBoundaries must be an array/);
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

    const tooManyBoundaries = Array.from(
      { length: FACT_LEDGER_MAX_KNOWLEDGE_BOUNDARIES + 1 },
      (_, i) => ({ id: `boundary-${i}`, holders: ["主角"] }),
    );
    expect(() => parseFactLedger({
      ...validLedger,
      knowledgeBoundaries: tooManyBoundaries,
    })).toThrow(new RegExp(
      `knowledgeBoundaries exceed ${FACT_LEDGER_MAX_KNOWLEDGE_BOUNDARIES}`,
    ));
  });

  it("accepts an empty update and returns an equivalent immutable result", () => {
    const current = parseFactLedger(validLedger);
    const currentJson = JSON.stringify(current);
    const candidate = {
      version: "1",
      appendEvents: [],
      upsertKnowledgeBoundaries: [],
      resolve: [],
      retireIds: [],
    };
    const candidateJson = JSON.stringify(candidate);
    const next = applyFactLedgerUpdate(current, candidate);

    expect(next).toEqual(current);
    expect(next).not.toBe(current);
    expect(JSON.stringify(current)).toBe(currentJson);
    expect(JSON.stringify(candidate)).toBe(candidateJson);

    const missingField = { ...candidate };
    delete missingField.retireIds;
    expect(() => applyFactLedgerUpdate(current, missingField)).toThrow(
      /retireIds is required/,
    );

    const extraField = { ...candidate, extra: 1 };
    expect(() => applyFactLedgerUpdate(current, extraField)).toThrow(
      /root contains unexpected fields/,
    );
  });

  it("applies public append, boundary upsert, and closes in one update", () => {
    const current = parseFactLedger({
      ...validLedger,
      knowledgeBoundaries: [{ id: "boundary-1", holders: ["主角"] }],
    });
    const next = applyFactLedgerUpdate(current, {
      version: "1",
      appendEvents: [{
        id: "public-2",
        text: "白临与主角共同确认东门开启。",
        source: "player",
        time: "次日午钟后",
        location: "主楼东门",
        witnesses: ["主角", "白临"],
        visibility: "public",
        causedBy: ["public-1"],
      }],
      upsertKnowledgeBoundaries: [{ id: "boundary-1", holders: ["白临"] }],
      resolve: [],
      retireIds: ["derived-1"],
    });

    expect(next.events.map((event) => event.id)).toEqual([
      "public-1", "private-1", "public-2",
    ]);
    expect(next.knowledgeBoundaries).toEqual([
      { id: "boundary-1", holders: ["白临"] },
    ]);
    expect(next.events[2].causedBy).toEqual(["public-1"]);
    expect(renderFactLedger(next)).toContain("id=public-2");
    expect(renderFactLedger(next)).toContain("仅以下角色掌握未公开事实：白临；");
  });

  it("normalizes holder ordering and rejects duplicate upsert boundary ids", () => {
    const current = parseFactLedger({ version: "1", events: [] });
    const next = applyFactLedgerUpdate(current, {
      version: "1",
      appendEvents: [],
      upsertKnowledgeBoundaries: [{ id: "boundary-1", holders: ["白临", "主角"] }],
      resolve: [],
      retireIds: [],
    });
    expect(next.knowledgeBoundaries).toEqual([
      { id: "boundary-1", holders: ["主角", "白临"] },
    ]);

    expect(() => applyFactLedgerUpdate(current, {
      version: "1",
      appendEvents: [],
      upsertKnowledgeBoundaries: [
        { id: "boundary-1", holders: ["主角"] },
        { id: "boundary-1", holders: ["白临"] },
      ],
      resolve: [],
      retireIds: [],
    })).toThrow(/duplicate upsert boundary id boundary-1/);
  });

  it("can append events that reference an earlier appended event in the same candidate", () => {
    const current = parseFactLedger({ version: "1", events: [] });
    const next = applyFactLedgerUpdate(current, {
      version: "1",
      appendEvents: [
        {
          id: "public-1",
          text: "主角在北门点火。",
          source: "player",
          time: "第一夜",
          location: "北门",
          witnesses: ["主角"],
          visibility: "public",
          causedBy: [],
        },
        {
          id: "public-2",
          text: "火光被城内看见。",
          source: "system",
          time: "第一夜",
          location: "北门",
          witnesses: ["主角"],
          visibility: "public",
          causedBy: ["public-1"],
        },
      ],
      upsertKnowledgeBoundaries: [],
      resolve: [],
      retireIds: [],
    });
    expect(next.events.map((event) => event.id)).toEqual(["public-1", "public-2"]);
  });

  it("rejects mixed public/private append and private derivation through append", () => {
    const current = parseFactLedger(validLedger);
    const privateAppend = {
      version: "1",
      appendEvents: [{
        ...validLedger.events[1],
        id: "private-2",
      }],
      upsertKnowledgeBoundaries: [],
      resolve: [],
      retireIds: [],
    };
    expect(() => applyFactLedgerUpdate(current, privateAppend)).toThrow(
      /appendEvents\[0\]\.visibility must be public/,
    );

    const derivedPrivateAppend = {
      version: "1",
      appendEvents: [{
        ...validLedger.events[2],
        id: "derived-2",
        causedBy: ["private-1"],
      }],
      upsertKnowledgeBoundaries: [],
      resolve: [],
      retireIds: [],
    };
    expect(() => applyFactLedgerUpdate(current, derivedPrivateAppend)).not.toThrow();
    expect(renderFactLedger(applyFactLedgerUpdate(current, derivedPrivateAppend)))
      .not.toContain("derived-2");
  });

  it("rejects new ids that collide with current event or boundary ids", () => {
    const current = parseFactLedger({
      ...validLedger,
      knowledgeBoundaries: [{ id: "boundary-1", holders: ["主角"] }],
    });

    expect(() => applyFactLedgerUpdate(current, {
      version: "1",
      appendEvents: [{ ...validLedger.events[0] }],
      upsertKnowledgeBoundaries: [],
      resolve: [],
      retireIds: [],
    })).toThrow(/duplicate event id public-1/);

    expect(() => applyFactLedgerUpdate(current, {
      version: "1",
      appendEvents: [{
        ...validLedger.events[0],
        id: "boundary-1",
      }],
      upsertKnowledgeBoundaries: [],
      resolve: [],
      retireIds: [],
    })).toThrow(/conflicts with boundary id boundary-1/);

    expect(() => applyFactLedgerUpdate(current, {
      version: "1",
      appendEvents: [{
        ...validLedger.events[0],
        id: "public-1",
        causedBy: [],
      }],
      upsertKnowledgeBoundaries: [],
      resolve: [],
      retireIds: ["public-1"],
    })).toThrow(/duplicate event id public-1/);
  });

  it("rejects invalid upserts and closes atomically without mutating inputs", () => {
    const current = parseFactLedger({
      ...validLedger,
      knowledgeBoundaries: [{ id: "boundary-1", holders: ["主角"] }],
    });
    const currentJson = JSON.stringify(current);

    const eventCollision = {
      version: "1",
      appendEvents: [],
      upsertKnowledgeBoundaries: [{ id: "public-1", holders: ["主角"] }],
      resolve: [],
      retireIds: [],
    };
    expect(() => applyFactLedgerUpdate(current, eventCollision)).toThrow(
      /conflicts with event id public-1/,
    );

    const simultaneousClose = {
      version: "1",
      appendEvents: [],
      upsertKnowledgeBoundaries: [{ id: "boundary-1", holders: ["主角"] }],
      resolve: [],
      retireIds: ["boundary-1"],
    };
    expect(() => applyFactLedgerUpdate(current, simultaneousClose)).toThrow(
      /cannot upsert and retire boundary boundary-1/,
    );

    expect(JSON.stringify(current)).toBe(currentJson);
  });

  it("rejects close ids that do not exist or are duplicated", () => {
    const current = parseFactLedger(validLedger);
    expect(() => applyFactLedgerUpdate(current, {
      version: "1",
      appendEvents: [],
      upsertKnowledgeBoundaries: [],
      resolve: [],
      retireIds: ["unknown-1"],
    })).toThrow(/retire id unknown-1 does not exist/);

    expect(() => applyFactLedgerUpdate(current, {
      version: "1",
      appendEvents: [],
      upsertKnowledgeBoundaries: [],
      resolve: [],
      retireIds: ["public-1", "public-1"],
    })).toThrow(/retireIds contains duplicate values/);
  });

  it("rejects an update that would leave a dangling causedBy reference after close", () => {
    const current = parseFactLedger(validLedger);
    const candidate = {
      version: "1",
      appendEvents: [{
        ...validLedger.events[2],
        id: "derived-2",
        causedBy: ["public-1"],
      }],
      upsertKnowledgeBoundaries: [],
      resolve: [],
      retireIds: ["public-1"],
    };
    const candidateJson = JSON.stringify(candidate);
    expect(() => applyFactLedgerUpdate(current, candidate)).toThrow(
      /causedBy references later or unknown event public-1/,
    );
    expect(JSON.stringify(candidate)).toBe(candidateJson);
  });

  it("resolves only explicit pending events with retained public evidence", () => {
    const current = parseFactLedger({
      version: "1",
      events: [
        { ...validLedger.events[0], kind: "open-decision" },
        { ...validLedger.events[0], id: "evidence-1" },
      ],
    });
    const next = applyFactLedgerUpdate(current, {
      version: "1",
      appendEvents: [],
      upsertKnowledgeBoundaries: [],
      resolve: [{ id: "public-1", evidenceIds: ["evidence-1"] }],
      retireIds: [],
    });
    expect(next.events.map((event) => event.id)).toEqual(["evidence-1"]);

    expect(() => applyFactLedgerUpdate(current, {
      version: "1",
      appendEvents: [],
      upsertKnowledgeBoundaries: [],
      resolve: [],
      retireIds: ["public-1"],
    })).toThrow(/must be resolved with evidence/);
    expect(() => applyFactLedgerUpdate(current, {
      version: "1",
      appendEvents: [],
      upsertKnowledgeBoundaries: [],
      resolve: [{ id: "public-1", evidenceIds: [] }],
      retireIds: [],
    })).toThrow(/evidenceIds must not be empty/);
  });

  it("rejects over-limit updates atomically without pruning", () => {
    const events = Array.from({ length: FACT_LEDGER_MAX_EVENTS }, (_, i) => ({
      ...validLedger.events[0],
      id: `event-${i}`,
    }));
    const current = parseFactLedger({ version: "1", events });
    const append = {
      version: "1",
      appendEvents: [{ ...validLedger.events[0], id: "new-event" }],
      upsertKnowledgeBoundaries: [],
      resolve: [],
      retireIds: [],
    };
    expect(() => applyFactLedgerUpdate(current, append)).toThrow(
      `fact ledger: events exceed ${FACT_LEDGER_MAX_EVENTS}`,
    );

    const boundaries = Array.from({ length: FACT_LEDGER_MAX_KNOWLEDGE_BOUNDARIES }, (_, i) => ({
      id: `boundary-${i}`,
      holders: ["主角"],
    }));
    const boundaryCurrent = parseFactLedger({
      version: "1",
      events: [],
      knowledgeBoundaries: boundaries,
    });
    const boundaryAppend = {
      version: "1",
      appendEvents: [],
      upsertKnowledgeBoundaries: [{ id: "new-boundary", holders: ["主角"] }],
      resolve: [],
      retireIds: [],
    };
    expect(() => applyFactLedgerUpdate(boundaryCurrent, boundaryAppend)).toThrow(
      `fact ledger: knowledgeBoundaries exceed ${FACT_LEDGER_MAX_KNOWLEDGE_BOUNDARIES}`,
    );
  });

  it("replays the frozen public continuity card lifecycle", async () => {
    const replay = JSON.parse(await readFile(replayPath, "utf8")) as {
      current: unknown;
      updates: unknown[];
      invalidUpdate: unknown;
    };
    let ledger = parseFactLedger(replay.current);

    for (const update of replay.updates) {
      ledger = applyFactLedgerUpdate(ledger, update);
    }

    expect(ledger.events.map((event) => event.id)).toEqual([
      "public-e1",
      "public-e2",
      "public-e3",
      "public-e4",
    ]);
    expect(ledger.knowledgeBoundaries).toEqual([]);
    const rendered = renderFactLedger(ledger);
    expect(rendered).toContain("id=public-e3");
    expect(rendered).toContain("id=public-e4");
    expect(rendered).not.toContain("id=private-e1");
    expect(rendered).not.toContain("知识边界=");

    const beforeInvalid = JSON.stringify(ledger);
    expect(() => applyFactLedgerUpdate(ledger, replay.invalidUpdate)).toThrow(
      /causedBy references later or unknown event public-e2/,
    );
    expect(JSON.stringify(ledger)).toBe(beforeInvalid);
  });
});
