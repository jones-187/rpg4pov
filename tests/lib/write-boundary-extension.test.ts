import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import registerWriteBoundary, {
  validatePiWriteTarget,
  type PiToolCallHandler,
} from "../../pi-extensions/write-boundary";

async function makeWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-write-boundary-"));
  await fs.mkdir(path.join(dir, "turn"), { recursive: true });
  await fs.writeFile(path.join(dir, "turn", "output.md"), "旧输出\n");
  await fs.writeFile(path.join(dir, "turn", "interaction.json"), "{}\n");
  return dir;
}

describe("Pi write-boundary extension", () => {
  it.each(["turn/output.md", "turn/interaction.json", "turn/state-update.md"])(
    "allows only the exact candidate path %s",
    async (candidate) => {
      const cwd = await makeWorkspace();
      await expect(validatePiWriteTarget(cwd, candidate)).resolves.toEqual({ allowed: true });
    },
  );

  it.each([
    "/tmp/output.md",
    "../turn/output.md",
    "./turn/output.md",
    "turn\\output.md",
    "turn/output.md.bak",
    "turn/output.md/../interaction.json",
  ])("blocks path lookalike or escape: %s", async (candidate) => {
    const cwd = await makeWorkspace();
    const decision = await validatePiWriteTarget(cwd, candidate);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain("path");
  });

  it("blocks non-string paths", async () => {
    const cwd = await makeWorkspace();
    const decision = await validatePiWriteTarget(cwd, { toString: () => "turn/output.md" });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain("string");
  });

  it("blocks a candidate that is a symlink or directory", async () => {
    const cwd = await makeWorkspace();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "pi-write-outside-"));
    await fs.rm(path.join(cwd, "turn", "output.md"));
    await fs.symlink(path.join(outside, "outside.md"), path.join(cwd, "turn", "output.md"));
    const symlinkDecision = await validatePiWriteTarget(cwd, "turn/output.md");
    expect(symlinkDecision.allowed).toBe(false);

    await fs.rm(path.join(cwd, "turn", "interaction.json"));
    await fs.mkdir(path.join(cwd, "turn", "interaction.json"));
    const directoryDecision = await validatePiWriteTarget(cwd, "turn/interaction.json");
    expect(directoryDecision.allowed).toBe(false);
  });

  it("blocks a symlinked turn parent and allows a missing state-update file", async () => {
    const cwd = await makeWorkspace();
    await fs.rm(path.join(cwd, "turn"), { recursive: true });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "pi-turn-outside-"));
    await fs.symlink(outside, path.join(cwd, "turn"));
    const decision = await validatePiWriteTarget(cwd, "turn/state-update.md");
    expect(decision.allowed).toBe(false);

    await fs.rm(path.join(cwd, "turn"));
    await fs.mkdir(path.join(cwd, "turn"));
    await expect(validatePiWriteTarget(cwd, "turn/state-update.md")).resolves.toEqual({
      allowed: true,
    });
  });

  it("registers a tool_call handler that blocks write before execution", async () => {
    const cwd = await makeWorkspace();
    let handler: PiToolCallHandler | undefined;
    const api = {
      on(event: "tool_call", callback: PiToolCallHandler) {
        expect(event).toBe("tool_call");
        handler = callback;
      },
    };
    registerWriteBoundary(api);
    expect(handler).toBeDefined();

    await expect(
      handler!({ toolName: "write", input: { path: "turn/output.md" } }, { cwd }),
    ).resolves.toBeUndefined();
    const blocked = await handler!(
      { toolName: "write", input: { path: "../world.md" } },
      { cwd },
    );
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("path");
    await expect(handler!({ toolName: "bash", input: { command: "echo nope" } }, { cwd })).resolves.toBeUndefined();
  });
});
