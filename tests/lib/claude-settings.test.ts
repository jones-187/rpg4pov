import { describe, it, expect } from "vitest";
import { CLAUDE_SETTINGS_JSON, CLAUDE_SETTINGS_PATH } from "@/lib/claude-settings";

describe("claude-settings", () => {
  it("CLAUDE_SETTINGS_PATH 是容器受控路径，不在 workspace 内", () => {
    expect(CLAUDE_SETTINGS_PATH).toBe("/app/claude/settings.json");
    expect(CLAUDE_SETTINGS_PATH).not.toContain("workspaces");
  });

  it("settings 含 permissions.deny 规则，deny .env/.env.*/secrets", () => {
    const parsed = JSON.parse(CLAUDE_SETTINGS_JSON);
    expect(parsed.permissions).toBeDefined();
    expect(parsed.permissions.deny).toBeDefined();
    expect(parsed.permissions.deny).toContain("Read(./.env)");
    expect(parsed.permissions.deny).toContain("Read(./.env.*)");
    expect(parsed.permissions.deny).toContain("Read(./secrets/**)");
    expect(parsed.permissions.deny).toContain("Write(./.env)");
    expect(parsed.permissions.deny).toContain("Write(./.env.*)");
    expect(parsed.permissions.deny).toContain("Write(./secrets/**)");
  });

  it("settings allow Bash 仅一条规则且精确匹配 roll-choice 调用", () => {
    const parsed = JSON.parse(CLAUDE_SETTINGS_JSON);
    const bashRules = (parsed.permissions.allow as string[]).filter((r) => r.startsWith("Bash("));
    expect(bashRules).toEqual(["Bash(node /app/cli/roll-choice.js:*)"]);
  });

  // --- Issue 14：committed history 隔离（turns/** 对写工具双形态封锁） ---

  it("settings deny 封锁 turns/** 的 Write 与 Edit（相对形态）", () => {
    const parsed = JSON.parse(CLAUDE_SETTINGS_JSON);
    const deny = parsed.permissions.deny as string[];
    expect(deny).toContain("Write(./turns/**)");
    expect(deny).toContain("Edit(./turns/**)");
  });

  it("settings deny 封锁 turns/** 的容器绝对路径形态（deny 优先于宽 allow）", () => {
    const parsed = JSON.parse(CLAUDE_SETTINGS_JSON);
    const deny = parsed.permissions.deny as string[];
    expect(deny).toContain("Write(/app/data/workspaces/*/turns/**)");
    expect(deny).toContain("Edit(/app/data/workspaces/*/turns/**)");
  });

  it("settings allow 提供绝对路径写入面（真实 agent Write 调用 375/377 为绝对路径）", () => {
    const parsed = JSON.parse(CLAUDE_SETTINGS_JSON);
    const allow = parsed.permissions.allow as string[];
    expect(allow).toContain("Write(/app/data/workspaces/**)");
    expect(allow).toContain("Edit(/app/data/workspaces/**)");
    // 宽 allow 不得绕过 turns deny：deny 列表必须存在对应封锁
    const deny = parsed.permissions.deny as string[];
    expect(deny.some((r) => r.startsWith("Write(/app/data/workspaces/*/turns"))).toBe(true);
  });

  it("review 修复：宽 allow 之下，所有受保护路径都有绝对形态 deny（不可被绝对调用绕过）", () => {
    const parsed = JSON.parse(CLAUDE_SETTINGS_JSON);
    const deny = parsed.permissions.deny as string[];
    // story.md（agent 无权写）、turn/input.md（orchestrator 写入）
    expect(deny).toContain("Write(/app/data/workspaces/*/story.md)");
    expect(deny).toContain("Edit(/app/data/workspaces/*/story.md)");
    expect(deny).toContain("Write(/app/data/workspaces/*/turn/input.md)");
    expect(deny).toContain("Edit(/app/data/workspaces/*/turn/input.md)");
    // 工作区内 .env / secrets 的绝对形态
    expect(deny).toContain("Write(/app/data/workspaces/*/.env)");
    expect(deny).toContain("Write(/app/data/workspaces/*/.env.*)");
    expect(deny).toContain("Write(/app/data/workspaces/*/secrets/**)");
    expect(deny).toContain("Read(/app/data/workspaces/*/.env)");
  });

  it("review 修复：绝对路径 Read 放行（不依赖 default 模式对只读工具的门控语义）", () => {
    const parsed = JSON.parse(CLAUDE_SETTINGS_JSON);
    expect(parsed.permissions.allow).toContain("Read(/app/data/workspaces/**)");
  });

  it("绝对路径前缀单源化：settings 中不残留硬编码的散落副本", () => {
    // 除 roll-choice 的 /app/cli 前缀外，其余 /app/ 绝对规则都应指向 /app/data/workspaces
    const parsed = JSON.parse(CLAUDE_SETTINGS_JSON);
    const rules = [...(parsed.permissions.allow as string[]), ...(parsed.permissions.deny as string[])];
    const offenders = rules.filter(
      (r) => r.includes("/app/") && !r.includes("/app/data/workspaces") && !r.includes("/app/cli/"),
    );
    expect(offenders).toEqual([]);
  });

  it("settings allow 含 Read/Write workspace 文件", () => {
    const parsed = JSON.parse(CLAUDE_SETTINGS_JSON);
    const allow = parsed.permissions.allow as string[];
    expect(allow.some((r) => r.startsWith("Read("))).toBe(true);
    expect(allow.some((r) => r.startsWith("Write("))).toBe(true);
    expect(allow).toContain("Write(./turn/output.md)");
    expect(allow).toContain("Write(./turn/done.json)");
    expect(allow).toContain("Read(./turn/input.md)");
  });

  it("settings allow init agent 可写 rules.md（Issue 7）", () => {
    const parsed = JSON.parse(CLAUDE_SETTINGS_JSON);
    expect(parsed.permissions.allow).toContain("Write(./rules.md)");
  });

  it("settings allow 读取回合历史（Issue 6.5/7：runner prompt 要求读 turns/history.jsonl）", () => {
    const parsed = JSON.parse(CLAUDE_SETTINGS_JSON);
    expect(parsed.permissions.allow).toContain("Read(./turns/history.jsonl)");
    // 历史只读：Write 规则不得放行 turns/**
    expect((parsed.permissions.allow as string[]).some((r) => r.startsWith("Write(./turns"))).toBe(false);
  });

  it("settings 不含 dangerously skip permissions 或 bypassPermissions", () => {
    expect(CLAUDE_SETTINGS_JSON.toLowerCase()).not.toContain("dangerously");
    expect(CLAUDE_SETTINGS_JSON.toLowerCase()).not.toContain("bypasspermissions");
  });

  it("settings 含 env.USE_BUILTIN_RIPGREP=0（alpine musl 适配）", () => {
    const parsed = JSON.parse(CLAUDE_SETTINGS_JSON);
    expect(parsed.env?.USE_BUILTIN_RIPGREP).toBe("0");
  });
});
