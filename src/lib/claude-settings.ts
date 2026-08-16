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
 * 注意：绝对路径规则依赖容器默认 WORKSPACE_ROOT=/app/data/workspaces（workspace.ts
 * 默认值），统一由下方 WS 常量构造。若部署把 workspace 挂载到其他路径，同步该常量。
 */

/**
 * 容器默认 WORKSPACE_ROOT 绝对前缀（workspace.ts 默认 /app + data/workspaces）。
 * 绝对路径规则统一经此常量构造，避免 "/app/data/workspaces" 在多条规则中重复散落。
 * 若部署把 workspace 挂载到其他路径，只需同步此常量。
 */
const WS = "/app/data/workspaces";

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
        // Issue 14：受保护路径双形态封锁（相对 ./ 与容器绝对路径）。
        // default 模式下 allow 是白名单，但下方 WS/** 宽 allow 以绝对形态放行
        // 整个 workspace 写入面——凡"不该由 agent 写"的路径必须同时以绝对
        // 形态 deny，否则相对 deny 会被绝对调用绕过（review 修复）。
        // - turns/**：committed history（orchestrator 独占提交权）
        // - story.md：故事元数据（agent 无权写）
        // - turn/input.md：本回合输入（orchestrator 写入）
        // - 工作区内 .env* / secrets/**：与根级 deny 同语义的绝对形态
        `Write(./turns/**)`,
        `Edit(./turns/**)`,
        `Write(${WS}/*/turns/**)`,
        `Edit(${WS}/*/turns/**)`,
        `Write(./story.md)`,
        `Edit(./story.md)`,
        `Write(${WS}/*/story.md)`,
        `Edit(${WS}/*/story.md)`,
        `Write(./turn/input.md)`,
        `Edit(./turn/input.md)`,
        `Write(${WS}/*/turn/input.md)`,
        `Edit(${WS}/*/turn/input.md)`,
        `Read(${WS}/*/.env)`,
        `Read(${WS}/*/.env.*)`,
        `Read(${WS}/*/secrets/**)`,
        `Write(${WS}/*/.env)`,
        `Write(${WS}/*/.env.*)`,
        `Write(${WS}/*/secrets/**)`,
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
        // 绝对路径形态（真实 agent 调用主流形态；Read 为只读工具本就低敏，
        // 显式放行避免对 default 模式 Read 门控语义的依赖）
        `Read(${WS}/**)`,
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
        // 绝对路径写入面：workspace 全域减去上方 deny 的受保护路径
        // （turns/**、story.md、turn/input.md、.env*、secrets/**）
        `Write(${WS}/**)`,
        `Edit(${WS}/**)`,
        "Bash(node /app/cli/roll-choice.js:*)",
      ],
    },
  },
  null,
  2,
);
