import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  parseStateUpdate,
  applyStateUpdates,
  isAllowedStateFile,
} from "@/lib/state-update";

function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "state-update-"));
}

describe("isAllowedStateFile", () => {
  it("白名单顶层文件与 actors/*.md 允许", () => {
    expect(isAllowedStateFile("world.md")).toBe(true);
    expect(isAllowedStateFile("player.md")).toBe(true);
    expect(isAllowedStateFile("adjustments.md")).toBe(true);
    expect(isAllowedStateFile("tendencies.md")).toBe(true);
    expect(isAllowedStateFile("actors/lin.md")).toBe(true);
  });

  it("其他路径一律拒绝", () => {
    expect(isAllowedStateFile("story.md")).toBe(false);
    expect(isAllowedStateFile("turn/output.md")).toBe(false);
    expect(isAllowedStateFile("../outside.md")).toBe(false);
    expect(isAllowedStateFile("actors/nested/x.md")).toBe(false);
    expect(isAllowedStateFile("/etc/passwd")).toBe(false);
    expect(isAllowedStateFile("rules.md")).toBe(false);
  });
});

describe("parseStateUpdate", () => {
  it("解析 APPEND / REPLACE 与多段", () => {
    const raw = [
      "=== FILE: world.md ===",
      "APPEND: ## 时间线",
      "REPLACE: 暮冬，傍晚 → 暮冬，入夜",
      "=== FILE: actors/lin.md ===",
      "APPEND: - 新增行为记录",
    ].join("\n");
    const { sections, problems } = parseStateUpdate(raw);
    expect(problems).toEqual([]);
    expect(sections).toHaveLength(2);
    expect(sections[0].file).toBe("world.md");
    expect(sections[0].ops).toEqual([
      { kind: "append", text: "## 时间线" },
      { kind: "replace", from: "暮冬，傍晚", to: "暮冬，入夜" },
    ]);
    expect(sections[1].file).toBe("actors/lin.md");
  });

  it("白名单外文件段整段拒绝并记 problem", () => {
    const raw = ["=== FILE: story.md ===", "APPEND: 不该允许", "=== FILE: world.md ===", "APPEND: 合法"].join("\n");
    const { sections, problems } = parseStateUpdate(raw);
    expect(sections.map((s) => s.file)).toEqual(["world.md"]);
    expect(problems[0]).toContain("story.md");
  });

  it("无法解析的 REPLACE 降级记录，不中断", () => {
    const raw = ["=== FILE: world.md ===", "REPLACE: 没有箭头的行"].join("\n");
    const { sections, problems } = parseStateUpdate(raw);
    expect(sections).toHaveLength(1);
    expect(sections[0].ops).toHaveLength(0);
    expect(problems[0]).toContain("REPLACE");
  });

  it("段外内容忽略；APPEND 后续行并入同一条", () => {
    const raw = ["说明文字", "=== FILE: player.md ===", "APPEND: 第一行", "续行内容", "REPLACE: a → b"].join("\n");
    const { sections } = parseStateUpdate(raw);
    expect(sections).toHaveLength(1);
    expect(sections[0].ops[0]).toEqual({ kind: "append", text: "第一行\n续行内容" });
  });
});

describe("applyStateUpdates", () => {
  it("APPEND 追加、REPLACE 命中替换、actors 新文件可创建", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "world.md"), "# 世界\n旧状态行\n");
    await fs.mkdir(path.join(dir, "actors"), { recursive: true });

    const { sections } = parseStateUpdate(
      [
        "=== FILE: world.md ===",
        "REPLACE: 旧状态行 → 新状态行",
        "APPEND: ## 时间线",
        "=== FILE: actors/new-npc.md ===",
        "APPEND: # NPC：新角色",
      ].join("\n"),
    );
    const result = await applyStateUpdates(dir, sections);
    expect(result.errors).toEqual([]);
    expect(result.applied).toBe(3);

    const world = await fs.readFile(path.join(dir, "world.md"), "utf8");
    expect(world).toContain("新状态行");
    expect(world).not.toContain("旧状态行");
    expect(world.trimEnd().endsWith("## 时间线")).toBe(true);

    const npc = await fs.readFile(path.join(dir, "actors", "new-npc.md"), "utf8");
    expect(npc.trim()).toBe("# NPC：新角色");
  });

  it("REPLACE 未命中记 error 不中断", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "player.md"), "# 主角\n");
    const { sections } = parseStateUpdate(
      ["=== FILE: player.md ===", "REPLACE: 不存在的旧文 → 新文", "APPEND: 追加行"].join("\n"),
    );
    const result = await applyStateUpdates(dir, sections);
    expect(result.applied).toBe(1);
    expect(result.errors[0]).toContain("REPLACE miss");
    const player = await fs.readFile(path.join(dir, "player.md"), "utf8");
    expect(player).toContain("追加行");
  });
});

describe("parseStateUpdate：=== RANDOM === 申报段", () => {
  it("申报行进 rolls，不进文件段、不混入 APPEND 续行", () => {
    const { sections, rolls, problems } = parseStateUpdate(
      [
        "=== FILE: world.md ===",
        "APPEND: ## 时间线",
        "=== RANDOM ===",
        "R1: rollId=lockpick candidates=success:25,fail:75 → success",
        "R2: rollId=perception candidates=notice:60,miss:40 → miss",
        "=== FILE: player.md ===",
        "APPEND: 状态行",
      ].join("\n"),
    );
    expect(problems).toEqual([]);
    expect(sections.map((s) => s.file)).toEqual(["world.md", "player.md"]);
    // RANDOM 申报行没有被当作 world.md APPEND 的续行
    expect(sections[0]!.ops).toEqual([{ kind: "append", text: "## 时间线" }]);
    expect(rolls).toHaveLength(2);
    expect(rolls[0]).toEqual({
      index: 1,
      rollId: "lockpick",
      candidates: [
        { id: "success", weight: 25 },
        { id: "fail", weight: 75 },
      ],
      declaredSelectedId: "success",
    });
    expect(rolls[1]!.index).toBe(2);
  });

  it("申报行缺箭头结果仍可解析（declaredSelectedId 缺省）", () => {
    const { rolls } = parseStateUpdate("=== RANDOM ===\nR1: rollId=a candidates=x:1,y:1");
    expect(rolls[0]!.declaredSelectedId).toBeUndefined();
    expect(rolls[0]!.candidates).toEqual([
      { id: "x", weight: 1 },
      { id: "y", weight: 1 },
    ]);
  });

  it("畸形申报行记 problems 且跳过（权重非正、格式错乱）", () => {
    const { rolls, problems } = parseStateUpdate(
      [
        "=== RANDOM ===",
        "R1: rollId=a candidates=x:0,y:1 → x",
        "R2: 瞎写一行",
        "R3: rollId=b candidates=x:1 → x",
      ].join("\n"),
    );
    expect(rolls.map((r) => r.rollId)).toEqual(["b"]);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("unparseable roll line");
  });
});
