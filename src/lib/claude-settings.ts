/**
 * Claude Code 受控 settings 内容（Issue 6 起维护，Issue 14 收紧）。
 * 放容器受控路径 /app/claude/settings.json，不放 Story Workspace。
 * Dockerfile 构建阶段写入，运行时只读。
 *
 * permission 语义（Issue 14 经 claude CLI 2.1.140 实证）：
 * - deny 优先于 allow：`deny Bash` 会连 allow 的精确命令一起禁用（M3），
 *   所以"deny 一切 Bash + allow roll-choice"不可行；deny 用于精确封路径。
 * - auto 模式会自动放行一切未被 deny 的调用（含任意 Bash 写文件，M1）；
 *   default 模式下 settings.allow 才是真白名单——未匹配的调用一律拒绝（M2），
 *   runner 侧已配合改为 `--permission-mode default`。
 * - 真实 agent 的 Write 调用 375/377 使用绝对路径（M4 + 验收转录统计），
 *   相对 `./` 规则匹配不到绝对路径调用，故写入面同时提供两种形态。
 *
 * permission 语法遵循 Claude Code settings 规范：
 * - deny 优先于 allow
 * - Read(path)/Write(path)/Edit(path)/Bash(cmd) 形式
 * - path 支持 glob（** 匹配多级）
 *
 * Bash 规则匹配实际 roll-choice 调用：
 * claude 经 heredoc 调 `node /app/cli/roll-choice.js <<'JSON' ... JSON`，
 * Bash permission pattern 匹配命令前缀，故 allow `Bash(node /app/cli/roll-choice.js:*)`。
 *
 * 注意：绝对路径 allow 依赖容器默认 WORKSPACE_ROOT=/app/data/workspaces（workspace.ts
 * 默认值）。若部署把 workspace 挂载到其他路径，需同步本文件的绝对规则。
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
        // Issue 14：committed history（turns/**）对一切写工具关闭，
        // 相对 ./ 与容器绝对路径两种形态都封；deny 优先于 allow 保证
        // 下方 /app/data/workspaces/** 的宽 allow 也放不进 turns。
        "Write(./turns/**)",
        "Edit(./turns/**)",
        "Write(/app/data/workspaces/*/turns/**)",
        "Edit(/app/data/workspaces/*/turns/**)",
      ],
      allow: [
        "Read(./story.md)",
        "Read(./world.md)",
        "Read(./player.md)",
        "Read(./rules.md)",
        "Read(./adjustments.md)",
        "Read(./tendencies.md)",
        "Read(./turn/input.md)",
        "Read(./turns/history.jsonl)",
        "Read(./actors/**)",
        "Read(./logs/**)",
        "Write(./turn/output.md)",
        "Write(./turn/interaction.json)",
        "Write(./turn/done.json)",
        "Write(./world.md)",
        "Write(./player.md)",
        "Write(./rules.md)",
        "Write(./adjustments.md)",
        "Write(./tendencies.md)",
        "Write(./actors/**)",
        "Write(./logs/**)",
        // 绝对路径形态（真实 agent 写入的主流形态）：
        // workspace 内全部可写面 + turns/** 已被上方 deny 封锁
        "Write(/app/data/workspaces/**)",
        "Edit(/app/data/workspaces/**)",
        "Bash(node /app/cli/roll-choice.js:*)",
      ],
    },
  },
  null,
  2,
);
