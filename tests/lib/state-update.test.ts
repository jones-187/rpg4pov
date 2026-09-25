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
    expect(isAllowedStateFile("actors\\lin.md")).toBe(false);
    expect(isAllowedStateFile("actors/../world.md")).toBe(false);
    expect(isAllowedStateFile("actors/lin\0.md")).toBe(false);
    expect(isAllowedStateFile("rules.md")).toBe(false);
  });
});

describe("parseStateUpdate", () => {
  it("解析结构化 JSON 的多行 APPEND/REPLACE 并可真实应用", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "world.md"), "旧文第一行\n旧文第二行\n");
    const raw = JSON.stringify({
      sections: [{
        file: "world.md",
        ops: [
          { kind: "replace", from: "旧文第一行\n旧文第二行", to: "新文第一行\n新文第二行" },
          { kind: "append", text: "新增第一行\n新增第二行" },
        ],
      }],
      rolls: [],
    });

    const parsed = parseStateUpdate(raw);
    expect(parsed).toEqual({
      sections: [{
        file: "world.md",
        ops: [
          { kind: "replace", from: "旧文第一行\n旧文第二行", to: "新文第一行\n新文第二行" },
          { kind: "append", text: "新增第一行\n新增第二行" },
        ],
      }],
      rolls: [],
      problems: [],
    });
    await expect(applyStateUpdates(dir, parsed.sections)).resolves.toEqual({ applied: 2, errors: [] });
    await expect(fs.readFile(path.join(dir, "world.md"), "utf8")).resolves.toBe(
      "新文第一行\n新文第二行\n新增第一行\n新增第二行\n",
    );
  });

  it("结构化 JSON 允许 sections/rolls 都为空", () => {
    expect(parseStateUpdate(JSON.stringify({ sections: [], rolls: [] }))).toEqual({
      sections: [],
      rolls: [],
      problems: [],
    });
  });

  it("结构化 JSON 任一 schema 错误都整批拒绝，不返回部分 sections/rolls", () => {
    const invalids = [
      {
        sections: [{ file: "story.md", ops: [{ kind: "append", text: "越界" }] }],
        rolls: [],
      },
      {
        sections: [
          { file: "world.md", ops: [{ kind: "append", text: "一" }] },
          { file: "world.md", ops: [{ kind: "append", text: "二" }] },
        ],
        rolls: [],
      },
      {
        sections: [{ file: "world.md", ops: [{ kind: "append", text: "内容", extra: true }] }],
        rolls: [],
      },
      {
        sections: [{ file: "world.md", ops: [{ kind: "replace", to: "新文" }] }],
        rolls: [],
      },
      {
        sections: [],
        rolls: [{
          index: 1,
          rollId: "risk",
          candidates: [{ id: "yes", weight: 0 }],
          declaredSelectedId: "yes",
        }],
      },
      {
        sections: [],
        rolls: [],
        unknown: true,
      },
    ];

    for (const value of invalids) {
      const parsed = parseStateUpdate(JSON.stringify(value));
      expect(parsed.sections).toEqual([]);
      expect(parsed.rolls).toEqual([]);
      expect(parsed.problems.length).toBeGreaterThan(0);
    }
  });

  it("结构化 JSON 的输入超过 100k 会拒绝，旧 Markdown 空 APPEND 仍拒绝", () => {
    expect(parseStateUpdate("x".repeat(100_001)).problems.length).toBeGreaterThan(0);
    const parsed = parseStateUpdate("=== FILE: world.md ===\nAPPEND:");
    expect(parsed.sections).toEqual([]);
    expect(parsed.problems.some((problem) => problem.includes("empty APPEND"))).toBe(true);
  });

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
    expect(sections).toEqual([]);
    expect(problems[0]).toContain("story.md");
  });

  it("无法解析的 REPLACE 降级记录，不中断", () => {
    const raw = ["=== FILE: world.md ===", "REPLACE: 没有箭头的行"].join("\n");
    const { sections, problems } = parseStateUpdate(raw);
    expect(sections).toEqual([]);
    expect(problems[0]).toContain("REPLACE");
  });

  it("段外内容记 problem；APPEND 后续行并入同一条", () => {
    const raw = ["说明文字", "=== FILE: player.md ===", "APPEND: 第一行", "续行内容", "REPLACE: a → b"].join("\n");
    const { sections, problems } = parseStateUpdate(raw);
    expect(problems[0]).toContain("outside");
    expect(sections).toEqual([]);
  });

  it("保留合法多行 APPEND 内容", () => {
    const raw = ["=== FILE: player.md ===", "APPEND: 第一行", "续行内容", "", "  缩进续行"].join("\n");
    const { sections, problems } = parseStateUpdate(raw);
    expect(problems).toEqual([]);
    expect(sections).toHaveLength(1);
    expect(sections[0].ops[0]).toEqual({ kind: "append", text: "第一行\n续行内容\n\n  缩进续行" });
  });

  it("空白、无操作段、空操作和未知操作都记 problem", () => {
    expect(parseStateUpdate("   \n\t").problems.length).toBeGreaterThan(0);
    const parsed = parseStateUpdate(
      [
        "=== FILE: world.md ===",
        "DELETE: 不支持",
        "=== FILE: player.md ===",
        "APPEND:",
        "=== FILE: actors/lin.md ===",
      ].join("\n"),
    );
    expect(parsed.problems.length).toBeGreaterThanOrEqual(3);
    expect(parsed.sections).toEqual([]);
  });

  it("NO CHANGES 是无变更且无问题的明确标记", () => {
    expect(parseStateUpdate("  === NO CHANGES ===  \n\n")).toEqual({ sections: [], rolls: [], problems: [] });
  });

  it("NO CHANGES 可以与 RANDOM 申报组合，且仅 RANDOM 也有效", () => {
    const combined = parseStateUpdate(
      ["=== NO CHANGES ===", "=== RANDOM ===", "R1: rollId=notice candidates=yes:1 → yes"].join("\n"),
    );
    expect(combined.sections).toEqual([]);
    expect(combined.problems).toEqual([]);
    expect(combined.rolls).toHaveLength(1);

    const randomOnly = parseStateUpdate("=== RANDOM ===\nR1: rollId=notice candidates=yes:1 → yes");
    expect(randomOnly.sections).toEqual([]);
    expect(randomOnly.problems).toEqual([]);
    expect(randomOnly.rolls).toHaveLength(1);
  });

  it("重复文件段会阻止整个解析结果", () => {
    const parsed = parseStateUpdate(
      ["=== FILE: world.md ===", "APPEND: 一", "=== FILE: world.md ===", "APPEND: 二"].join("\n"),
    );
    expect(parsed.sections).toEqual([]);
    expect(parsed.problems.some((problem) => problem.includes("duplicate"))).toBe(true);
  });

  it("REPLACE 允许删除，from 不能为空", () => {
    const parsed = parseStateUpdate(
      ["=== FILE: world.md ===", "REPLACE: 要删除的段落 →", "REPLACE:  → 新值"].join("\n"),
    );
    expect(parsed.sections).toEqual([]);
    expect(parsed.problems.some((problem) => problem.includes("from"))).toBe(true);
    const deletion = parseStateUpdate("=== FILE: world.md ===\nREPLACE: 要删除的段落 →");
    expect(deletion.problems).toEqual([]);
    expect(deletion.sections[0]?.ops).toEqual([{ kind: "replace", from: "要删除的段落", to: "" }]);
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

  it("REPLACE 未命中时整批失败且不写入其他操作", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "player.md"), "# 主角\n");
    const { sections } = parseStateUpdate(
      ["=== FILE: player.md ===", "REPLACE: 不存在的旧文 → 新文", "APPEND: 追加行"].join("\n"),
    );
    const result = await applyStateUpdates(dir, sections);
    expect(result.applied).toBe(0);
    expect(result.errors[0]).toContain("REPLACE miss");
    const player = await fs.readFile(path.join(dir, "player.md"), "utf8");
    expect(player).toBe("# 主角\n");
  });

  it("REPLACE 多次命中时整批失败且不写入", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "world.md"), "重复\n重复\n");
    const { sections } = parseStateUpdate("=== FILE: world.md ===\nREPLACE: 重复 → 新值");
    const result = await applyStateUpdates(dir, sections);
    expect(result.applied).toBe(0);
    expect(result.errors.some((error) => error.includes("multiple"))).toBe(true);
    expect(await fs.readFile(path.join(dir, "world.md"), "utf8")).toBe("重复\n重复\n");
  });

  it("REPLACE 的空 to 删除唯一命中的文本", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "world.md"), "保留\n删除这行\n结尾\n");
    const { sections } = parseStateUpdate("=== FILE: world.md ===\nREPLACE: 删除这行 →");
    const result = await applyStateUpdates(dir, sections);
    expect(result).toEqual({ applied: 1, errors: [] });
    expect(await fs.readFile(path.join(dir, "world.md"), "utf8")).toBe("保留\n\n结尾\n");
  });

  it("所有目标都验证并准备成功后才写入，任一目标错误则全部不写", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "world.md"), "旧世界\n");
    const { sections } = parseStateUpdate(
      [
        "=== FILE: world.md ===",
        "REPLACE: 旧世界 → 新世界",
        "=== FILE: player.md ===",
        "REPLACE: 缺失文本 → 新值",
      ].join("\n"),
    );
    const result = await applyStateUpdates(dir, sections);
    expect(result.applied).toBe(0);
    expect(result.errors).not.toEqual([]);
    expect(await fs.readFile(path.join(dir, "world.md"), "utf8")).toBe("旧世界\n");
    await expect(fs.access(path.join(dir, "player.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("拒绝符号链接目标和父目录", async () => {
    const dir = await tmpDir();
    const outside = await tmpDir();
    await fs.writeFile(path.join(outside, "secret.md"), "secret\n");
    await fs.symlink(path.join(outside, "secret.md"), path.join(dir, "world.md"));
    const targetResult = await applyStateUpdates(dir, [
      { file: "world.md", ops: [{ kind: "append", text: "不应写入" }] },
    ]);
    expect(targetResult.applied).toBe(0);
    expect(targetResult.errors.some((error) => error.includes("symlink"))).toBe(true);
    expect(await fs.readFile(path.join(outside, "secret.md"), "utf8")).toBe("secret\n");

    await fs.rm(path.join(dir, "world.md"));
    await fs.symlink(outside, path.join(dir, "actors"));
    const parentResult = await applyStateUpdates(dir, [
      { file: "actors/new.md", ops: [{ kind: "append", text: "不应写入" }] },
    ]);
    expect(parentResult.applied).toBe(0);
    expect(parentResult.errors.some((error) => error.includes("symlink"))).toBe(true);
    await expect(fs.access(path.join(outside, "new.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("仅 ENOENT 的 APPEND 允许创建新 actor 文件", async () => {
    const dir = await tmpDir();
    const result = await applyStateUpdates(dir, [
      { file: "actors/new.md", ops: [{ kind: "append", text: "新角色" }] },
    ]);
    expect(result).toEqual({ applied: 1, errors: [] });
    expect(await fs.readFile(path.join(dir, "actors/new.md"), "utf8")).toBe("新角色");
  });

  it("非 ENOENT 的目标 I/O 异常向上抛出", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "actors"), "这不是目录\n");
    await expect(
      applyStateUpdates(dir, [{ file: "actors/new.md", ops: [{ kind: "append", text: "新角色" }] }]),
    ).rejects.toMatchObject({ code: "ENOTDIR" });
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
