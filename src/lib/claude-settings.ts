/**
 * Claude Code 受控 settings 内容（Issue 6）。
 * 放容器受控路径 /app/claude/settings.json，不放 Story Workspace。
 * Dockerfile 构建阶段写入，运行时只读。
 *
 * permission 语法遵循 Claude Code settings 规范：
 * - deny 优先于 allow
 * - Read(path)/Write(path)/Bash(cmd) 形式
 * - path 支持 glob（** 匹配多级）
 *
 * Bash 规则匹配实际 roll-choice 调用：
 * claude 经 heredoc 调 `node /app/cli/roll-choice.js <<'JSON' ... JSON`，
 * Bash permission pattern 匹配命令前缀，故 allow `Bash(node /app/cli/roll-choice.js:*)`。
 */

export const CLAUDE_SETTINGS_PATH = "/app/claude/settings.json";

export const CLAUDE_SETTINGS_JSON = JSON.stringify(
  {
    env: {
      USE_BUILTIN_RIPGREP: "0",
    },
    permissions: {
      deny: [
        "Read(./.env)",
        "Read(./.env.*)",
        "Read(./secrets/**)",
        "Write(./.env)",
        "Write(./.env.*)",
        "Write(./secrets/**)",
      ],
      allow: [
        "Read(./story.md)",
        "Read(./world.md)",
        "Read(./player.md)",
        "Read(./rules.md)",
        "Read(./turn/input.md)",
        "Read(./actors/**)",
        "Read(./logs/**)",
        "Write(./turn/output.md)",
        "Write(./turn/done.json)",
        "Write(./world.md)",
        "Write(./player.md)",
        "Write(./actors/**)",
        "Write(./logs/**)",
        "Bash(node /app/cli/roll-choice.js:*)",
      ],
    },
  },
  null,
  2,
);
