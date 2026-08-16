import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  sanitizeTurnInteraction,
  readTurnInteraction,
  readTurnInteractionRawLine,
  DEFAULT_TURN_INTERACTION,
} from "@/lib/turn-interaction";
import { createStory, resolveWorkspaceDir } from "@/lib/workspace";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";

const VALID = { mode: "decision", suggestions: ["追问她的意思", "先保持沉默"] };

describe("sanitizeTurnInteraction", () => {
  it("passes valid continue state with no suggestions", () => {
    expect(sanitizeTurnInteraction({ mode: "continue", suggestions: [] })).toEqual({
      mode: "continue",
      suggestions: [],
    });
  });

  it("passes valid decision state with suggestions", () => {
    expect(sanitizeTurnInteraction(VALID)).toEqual(VALID);
  });

  it("drops empty suggestion strings", () => {
    expect(
      sanitizeTurnInteraction({ mode: "decision", suggestions: ["", "  ", "开口"] }),
    ).toEqual({ mode: "decision", suggestions: ["开口"] });
  });

  it("allows 0 suggestions at a decision point", () => {
    expect(sanitizeTurnInteraction({ mode: "decision" })).toEqual({
      mode: "decision",
      suggestions: [],
    });
  });

  it("truncates to first 4 suggestions instead of losing the decision state", () => {
    expect(
      sanitizeTurnInteraction({ mode: "decision", suggestions: ["1", "2", "3", "4", "5"] }),
    ).toEqual({ mode: "decision", suggestions: ["1", "2", "3", "4"] });
  });

  it("drops over-long suggestions but keeps the mode", () => {
    expect(
      sanitizeTurnInteraction({ mode: "decision", suggestions: ["x".repeat(121), "开口"] }),
    ).toEqual({ mode: "decision", suggestions: ["开口"] });
  });

  it("rejects invalid mode", () => {
    expect(sanitizeTurnInteraction({ mode: "epilogue", suggestions: [] })).toBeNull();
    expect(sanitizeTurnInteraction({ suggestions: [] })).toBeNull();
  });

  it("drops non-string suggestion entries, rejects non-array suggestions", () => {
    expect(sanitizeTurnInteraction({ mode: "decision", suggestions: ["ok", 3] })).toEqual({
      mode: "decision",
      suggestions: ["ok"],
    });
    expect(sanitizeTurnInteraction({ mode: "decision", suggestions: "追问" })).toBeNull();
  });

  it("rejects non-object values", () => {
    expect(sanitizeTurnInteraction(null)).toBeNull();
    expect(sanitizeTurnInteraction("continue")).toBeNull();
  });

  it("strips extra metadata fields (Issue 12: 元数据不外泄)", () => {
    const sanitized = sanitizeTurnInteraction({
      mode: "decision",
      suggestions: ["开口"],
      hiddenIntent: "她其实想请你留下",
      reason: "internal narrative judgment",
    });
    expect(sanitized).toEqual({ mode: "decision", suggestions: ["开口"] });
  });
});

describe("readTurnInteraction", () => {
  let root: string;

  beforeEach(async () => {
    root = await useTempWorkspaceRoot();
  });
  afterEach(() => {
    resetWorkspaceRoot();
  });

  async function writeInteraction(storyId: string, content: string): Promise<void> {
    await fs.writeFile(path.join(resolveWorkspaceDir(storyId), "turn", "interaction.json"), content);
  }

  it("degrades to default when file is missing", async () => {
    const story = await createStory();
    expect(await readTurnInteraction(story.storyId)).toEqual(DEFAULT_TURN_INTERACTION);
  });

  it("returns sanitized state when file is valid", async () => {
    const story = await createStory();
    await writeInteraction(story.storyId, JSON.stringify(VALID));
    expect(await readTurnInteraction(story.storyId)).toEqual(VALID);
  });

  it("degrades to default on malformed JSON", async () => {
    const story = await createStory();
    await writeInteraction(story.storyId, "{not json");
    expect(await readTurnInteraction(story.storyId)).toEqual(DEFAULT_TURN_INTERACTION);
  });

  it("degrades to default on invalid structure", async () => {
    const story = await createStory();
    await writeInteraction(story.storyId, JSON.stringify({ mode: "battle" }));
    expect(await readTurnInteraction(story.storyId)).toEqual(DEFAULT_TURN_INTERACTION);
  });

  it("raw line returns compact JSON for leak fingerprinting, null when missing", async () => {
    const story = await createStory();
    expect(await readTurnInteractionRawLine(story.storyId)).toBeNull();
    await writeInteraction(story.storyId, JSON.stringify(VALID, null, 2));
    expect(await readTurnInteractionRawLine(story.storyId)).toBe(JSON.stringify(VALID));
    expect(root).toBeTruthy();
  });
});
