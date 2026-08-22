/**
 * Claude Code 受控 settings 内容（Issue 6 起维护，Issue 14 收紧）。
 * 放容器受控路径 /app/claude/settings.json，不放 Story Workspace。
 * Dockerfile 构建阶段写入，运行时只读。
 *
 * permission 语义（性能优化分支实测修正，2026-08）：
 * - claude CLI 2.1.140 + 第三方网关环境下，permissions 的路径规则对 Write 调用
 *   完全不匹配（相对 ./、绝对 /、glob ** 形式的 allow 与 deny 均无效）：
 *   default 模式因此全拒（写入排队等确认直至空转退出），acceptEdits 连 deny
 *   都无视。Issue 14 时期"双形态规则"从未真正生效。
 * - 现行治理：runner 传 --tools=Read,Write（Bash 等工具对模型不存在）+
 *   --permission-mode auto（放行读写）；orchestrator 独占文件（turns/**、
 *   story.md、turn/input.md）由代码层基线比对守卫（见 turn-orchestrator 8.7）。
 * - 本文件保留 env.USE_BUILTIN_RIPGREP 与规则文本：规则当前不生效但作为
 *   预期写权面的文档留存，若未来 CLI 版本修复路径匹配可重新启用 default 模式。
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
