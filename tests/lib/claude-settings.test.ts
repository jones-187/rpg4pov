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
  });

  it("settings 含 permissions.allow，allow Bash 仅匹配 roll-choice 调用", () => {
    const parsed = JSON.parse(CLAUDE_SETTINGS_JSON);
    expect(parsed.permissions.allow).toBeDefined();
    const bashRules = (parsed.permissions.allow as string[]).filter((r) => r.startsWith("Bash("));
    for (const rule of bashRules) {
      expect(rule).toContain("roll-choice.js");
    }
  });

  it("settings allow 含 Read/Write workspace 文件", () => {
    const parsed = JSON.parse(CLAUDE_SETTINGS_JSON);
    const allow = parsed.permissions.allow as string[];
    expect(allow.some((r) => r.startsWith("Read("))).toBe(true);
    expect(allow.some((r) => r.startsWith("Write("))).toBe(true);
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
