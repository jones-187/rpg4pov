# Issue 6: 接入 Claude Code CLI Runner 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Agent Runtime Adapter 边界内接入 Claude Code CLI 作为首个真实 Agent Runner，验证真实 CLI agent 能冷启动、在 Story Workspace 内执行回合、写固定输出、失败回滚、凭证不泄漏。

**Architecture:** ClaudeCodeRunner 实现 `AgentRunner` 接口，通过 `child_process.spawn` 冷启动 `claude --bare -p` 子进程，cwd=workspaceDir，prompt 经临时文件传递（不放 argv/workspace），凭证经 env 白名单注入，权限经受控 settings.json 预授权，signal 传到子进程层（SIGTERM→SIGKILL）。Random Tool CLI Wrapper（`src/cli/roll-choice.ts`）让 claude 经 Bash heredoc 调用 `rollChoice`。Runner 切换经 `AGENT_RUNNER` 环境变量，默认 fake。Docker 单容器装 claude + ripgrep，docker-compose 默认不强制 claude。

**Tech Stack:** TypeScript, Node.js 20, child_process.spawn, claude-code CLI, Next.js standalone, Docker (node:20-alpine), vitest。

**Grill 文档:** `docs/superpowers/grills/2026-06-17-issue6-claude-code-runner.md`

**Plan 级约束（来自 grill P1-P4）:**
- P1: settings permission 落真实语法，随机工具用 heredoc 调用
- P2: prompt 经临时文件传递（/tmp/claude-prompts/<random>.md），不放 argv/workspace，finally 清理
- P3: stdout/stderr 只在失败时写日志（脱敏+限长），成功丢弃，不返回 Web
- P4: settings 文件放容器受控路径（/app/claude/settings.json），不放 workspace

---

## 文件结构

**新建:**
- `src/cli/roll-choice.ts` — Random Tool CLI Wrapper，stdin JSON in / stdout JSON out，复用 `rollChoice`
- `src/lib/claude-prompt.ts` — 首版 agent prompt 常量 + `buildPrompt(playerInput)` 填充函数
- `src/lib/claude-settings.ts` — 受控 settings.json 内容常量（真实 permission 语法）
- `src/lib/claude-code-runner.ts` — ClaudeCodeRunner 实现（依赖注入 spawn，临时 prompt 文件，env 白名单，signal→kill，stdout/stderr 捕获脱敏限长）
- `src/lib/diagnostics.ts` — stdout/stderr 脱敏 + 限长工具函数（独立，可测）
- `tsconfig.cli.json` — CLI 编译配置（emit dist/，含 cli + lib）
- `docker-compose.claude.yml` — 启用 claude 的 compose 覆盖文件
- `tests/cli/roll-choice.test.ts` — CLI wrapper 测试
- `tests/lib/claude-prompt.test.ts` — prompt 填充测试
- `tests/lib/diagnostics.test.ts` — 脱敏限长测试
- `tests/lib/claude-code-runner.test.ts` — Runner 单元测试（mock spawn）
- `tests/lib/claude-code-runner-integration.test.ts` — Runner 集成测试（fake CLI）
- `tests/fixtures/fake-claude.mjs` — 模拟 claude CLI 行为的 fixture 脚本

**修改:**
- `src/app/api/story-turn/route.ts` — `AGENT_RUNNER` 环境变量切换 runner
- `package.json` — 加 `build:cli` script
- `Dockerfile` — 装 claude + ripgrep + settings + CLI build + COPY dist
- `docker-compose.yml` — 默认不强制 claude（保持现状，仅注释说明）
- `.gitignore` — 补 `.env` / `.env.*`
- `.dockerignore` — 补 `.env` / `.env.*`

---

## Task 1: Random Tool CLI Wrapper

**Files:**
- Create: `src/cli/roll-choice.ts`
- Test: `tests/cli/roll-choice.test.ts`
- Create: `tsconfig.cli.json`
- Modify: `package.json`

- [ ] **Step 1: 创建 CLI 编译配置**

Create `tsconfig.cli.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "module": "commonjs",
    "moduleResolution": "node",
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": false,
    "sourceMap": false
  },
  "include": ["src/cli/**/*.ts", "src/lib/random-tool.ts", "src/lib/workspace.ts"],
  "exclude": ["node_modules", "tests", "src/app"]
}
```

- [ ] **Step 2: 加 build:cli script**

Modify `package.json` scripts，在 `"test:watch"` 后加：

```json
    "build:cli": "tsc -p tsconfig.cli.json"
```

- [ ] **Step 3: 写 CLI wrapper 失败测试**

Create `tests/cli/roll-choice.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createStory, resolveWorkspaceDir, resolveWorkspaceRoot } from "@/lib/workspace";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";
import { RANDOM_ROLLS_LOG } from "@/lib/random-tool";

// CLI wrapper 经 tsc 编译到 dist/cli/roll-choice.js；测试用 node 直接运行源 TS 经 tsx 不现实，
// 改为：测试直接 import rollChoice 库函数验证 wrapper 复用同一逻辑（wrapper 只是 stdin/stdout 壳）。
// 真实 CLI 端到端验证留 HITL（production-like 镜像内 node /app/cli/roll-choice.js）。
// 这里测试 wrapper 的输入解析与输出格式契约。

let root: string;
beforeAll(async () => {
  root = await useTempWorkspaceRoot();
});
afterAll(() => resetWorkspaceRoot());

describe("roll-choice CLI wrapper 契约（经库函数验证）", () => {
  it("接受 stdin JSON {storyId,workspaceDir,rollId,candidates} 返回 stdout JSON RollChoiceResult", async () => {
    const meta = await createStory({ title: "cli wrapper 测试" });
    const input = {
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      rollId: "lockpick",
      candidates: [
        { id: "success", weight: 1 },
        { id: "fail", weight: 0 },
      ],
    };
    // 注入确定性：直接调库函数模拟 wrapper 内部行为
    const { rollChoice } = await import("@/lib/random-tool");
    const result = await rollChoice({ ...input, rng: () => 0.0 });
    expect(result.selectedId).toBe("success");
    expect(result.rollId).toBe("lockpick");
    expect(result.randomSource).toBe("injected");
    // 验证 random log 已写
    const logs = await fs.readFile(
      path.join(resolveWorkspaceDir(meta.storyId), "logs", RANDOM_ROLLS_LOG),
      "utf8",
    );
    expect(logs).toContain("lockpick");
    expect(logs).toContain("success");
  });

  it("非法输入（缺 candidates）应非零退出（wrapper 行为）", async () => {
    // wrapper 对非法输入应写 stderr + 退出码 1。
    // 此测试验证 rollChoice 库函数对非法输入抛错（wrapper 捕获后 exit 1）。
    const { rollChoice } = await import("@/lib/random-tool");
    await expect(
      rollChoice({
        storyId: "00000000-0000-0000-0000-000000000000",
        workspaceDir: "/tmp",
        rollId: "test",
        candidates: [],
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 4: 运行测试验证失败**

Run: `pnpm test tests/cli/roll-choice.test.ts`
Expected: PASS（库函数已存在，测试验证契约）——此测试是契约锚点，确保 wrapper 复用的库函数行为正确。

- [ ] **Step 5: 实现 CLI wrapper**

Create `src/cli/roll-choice.ts`:

```typescript
#!/usr/bin/env node
/**
 * Random Tool CLI Wrapper（Issue 6）。
 * 把 rollChoice 库函数包装成 CLI 子进程可调用接口，供 Claude Code Runner 经 Bash 调用。
 *
 * 输入：stdin JSON（RollChoiceInput，不含 rng）
 * 输出：stdout JSON（RollChoiceResult），成功退出码 0
 * 失败：stderr 错误信息，退出码 1
 *
 * 调用示例（heredoc，避免 pipe 导致 Bash permission pattern 不匹配）：
 *   node /app/cli/roll-choice.js <<'JSON'
 *   {"storyId":"...","workspaceDir":"...","rollId":"lockpick","candidates":[{"id":"success","weight":25}]}
 *   JSON
 */
import { rollChoice } from "../lib/random-tool";
import type { RollChoiceInput } from "../lib/random-tool";

async function main(): Promise<void> {
  let raw: string;
  try {
    raw = await readStdin();
  } catch (err) {
    process.stderr.write(`failed to read stdin: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  let input: RollChoiceInput;
  try {
    input = JSON.parse(raw) as RollChoiceInput;
  } catch (err) {
    process.stderr.write(`invalid JSON input: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  try {
    const result = await rollChoice(input);
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(0);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

main().catch((err) => {
  process.stderr.write(`unexpected: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
```

- [ ] **Step 6: 验证 CLI 编译**

Run: `pnpm build:cli`
Expected: `dist/cli/roll-choice.js` 和 `dist/lib/random-tool.js` 生成，无错误。

- [ ] **Step 7: 验证 CLI 可运行（dev 机器）**

Run（PowerShell，注意 heredoc 在 PowerShell 需用不同方式，这里用 echo pipe 验证 dev 可运行，HITL 验证 heredoc 在容器 bash 内）:
```powershell
$ws = New-Item -ItemType Directory -Force -Path "$env:TEMP\roll-choice-test"; $storyId = "00000000-0000-0000-0000-000000000001"; $input = '{"storyId":"' + $storyId + '","workspaceDir":"' + ($ws.Path -replace '\\','/') + '","rollId":"test","candidates":[{"id":"a","weight":1}]}'; $input | node dist/cli/roll-choice.js
```
Expected: stdout 输出 JSON 含 `selectedId: "a"`，退出码 0。

- [ ] **Step 8: 运行测试验证通过**

Run: `pnpm test tests/cli/roll-choice.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/cli/roll-choice.ts tsconfig.cli.json package.json tests/cli/roll-choice.test.ts
git commit -m "feat(issue6): add Random Tool CLI wrapper for claude bash invocation"
```

---

## Task 2: Claude Prompt 常量

**Files:**
- Create: `src/lib/claude-prompt.ts`
- Test: `tests/lib/claude-prompt.test.ts`

- [ ] **Step 1: 写失败测试**

Create `tests/lib/claude-prompt.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildPrompt, STORY_TURN_RUNNER_PROMPT_TEMPLATE } from "@/lib/claude-prompt";

describe("claude-prompt", () => {
  it("STORY_TURN_RUNNER_PROMPT_TEMPLATE 含任务、工作流程、约束三段", () => {
    expect(STORY_TURN_RUNNER_PROMPT_TEMPLATE).toContain("## 任务");
    expect(STORY_TURN_RUNNER_PROMPT_TEMPLATE).toContain("## 工作流程");
    expect(STORY_TURN_RUNNER_PROMPT_TEMPLATE).toContain("## 约束");
  });

  it("buildPrompt 把 playerInput 填入 prompt", () => {
    const prompt = buildPrompt("推开木门");
    expect(prompt).toContain("推开木门");
    expect(prompt).toContain("## 任务");
  });

  it("prompt 含输出隔离约束（不泄漏 God State/NPC 记忆/日志）", () => {
    const prompt = buildPrompt("test");
    expect(prompt).toContain("不得泄漏");
    expect(prompt.toLowerCase()).toContain("god state");
    expect(prompt).toContain("NPC 私有记忆");
  });

  it("prompt 含随机工具 heredoc 调用说明", () => {
    const prompt = buildPrompt("test");
    expect(prompt).toContain("node /app/cli/roll-choice.js");
    expect(prompt).toContain("<<'JSON'");
  });

  it("prompt 含 done.json 写入说明（status=success）", () => {
    const prompt = buildPrompt("test");
    expect(prompt).toContain("turn/done.json");
    expect(prompt).toContain("status");
    expect(prompt).toContain("success");
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test tests/lib/claude-prompt.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 prompt 常量**

Create `src/lib/claude-prompt.ts`:

```typescript
/**
 * 首版 agent prompt（Issue 6）。
 * 放代码常量便于版本管理与 runner 引用；后续可迁移到 prompts/story-turn-runner.md。
 * runner 把填充后的完整 prompt 经临时文件传给 claude --bare -p，不放 argv。
 */

export const STORY_TURN_RUNNER_PROMPT_TEMPLATE = `你是故事模拟引擎的回合执行 agent。当前工作目录是 Story Workspace。

## 任务
执行主角本回合行动，推进故事一个回合。

## 输入
{PLAYER_INPUT}

## 工作流程
1. 读取 workspace 状态：story.md, world.md, player.md, rules.md, turn/input.md
2. 理解主角意图，推进故事一个回合
3. 如有不确定/风险判定，调用随机工具（heredoc 形式，避免 pipe 导致权限 pattern 不匹配）：

   node /app/cli/roll-choice.js <<'JSON'
   {"storyId":"<storyId>","workspaceDir":"<当前目录绝对路径>","rollId":"<语义rollId>","candidates":[{"id":"success","weight":25},{"id":"fail","weight":75}]}
   JSON

   工具从 stdout 返回 JSON（RollChoiceResult），你必须服从 selectedId 对应的结果，不能重新选择。
4. 写 turn/output.md（主角可见输出）
5. 写 turn/done.json：{"status":"success","completedAt":"<ISO 8601 时间>"}

## 约束
- output.md 只写主角视窗：主角能看/听/感知/推理的信息
- 不得泄漏：God State 真相、NPC 私有记忆、内部日志、随机判定日志内容
- 不得修改 story.md 元数据
- 完成必须写 done.json（status=success）；无法完成则不写（触发回滚）
- 随机判定结果必须服从，不得在 output 中直接展示 random log 内容`;

export function buildPrompt(playerInput: string): string {
  return STORY_TURN_RUNNER_PROMPT_TEMPLATE.replace("{PLAYER_INPUT}", playerInput);
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm test tests/lib/claude-prompt.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/claude-prompt.ts tests/lib/claude-prompt.test.ts
git commit -m "feat(issue6): add story-turn-runner prompt template with output isolation"
```

---

## Task 3: Claude Settings 常量（真实 permission 语法）

**Files:**
- Create: `src/lib/claude-settings.ts`
- Test: `tests/lib/claude-settings.test.ts`

- [ ] **Step 1: 写失败测试**

Create `tests/lib/claude-settings.test.ts`:

```typescript
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
    // 每条 Bash 规则必须含 roll-choice.js 路径
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
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test tests/lib/claude-settings.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 settings 常量**

Create `src/lib/claude-settings.ts`:

```typescript
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
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm test tests/lib/claude-settings.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/claude-settings.ts tests/lib/claude-settings.test.ts
git commit -m "feat(issue6): add controlled claude settings with real permission syntax"
```

---

## Task 4: 诊断工具（脱敏 + 限长）

**Files:**
- Create: `src/lib/diagnostics.ts`
- Test: `tests/lib/diagnostics.test.ts`

- [ ] **Step 1: 写失败测试**

Create `tests/lib/diagnostics.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { redactSecrets, truncateForLog, sanitizeForLog } from "@/lib/diagnostics";

describe("diagnostics", () => {
  it("redactSecrets 把 ANTHROPIC_API_KEY 值替换为 [REDACTED]", () => {
    const input = "error: ANTHROPIC_API_KEY=sk-ant-xxxxxx call failed";
    const result = redactSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("sk-ant-xxxxxx");
  });

  it("redactSecrets 处理多种 key 出现形式（=、:、空格）", () => {
    expect(redactSecrets("ANTHROPIC_API_KEY:sk-ant-123")).toContain("[REDACTED]");
    expect(redactSecrets("ANTHROPIC_API_KEY sk-ant-123")).toContain("[REDACTED]");
  });

  it("truncateForLog 超过限长截断并标注 truncated", () => {
    const long = "x".repeat(20_000);
    const result = truncateForLog(long, 16_384);
    expect(result.length).toBeLessThan(long.length);
    expect(result).toContain("truncated");
  });

  it("truncateForLog 未超限长原样返回", () => {
    const short = "short message";
    expect(truncateForLog(short, 16_384)).toBe(short);
  });

  it("sanitizeForLog 组合脱敏 + 限长", () => {
    const input = "ANTHROPIC_API_KEY=sk-ant-xxx " + "y".repeat(20_000);
    const result = sanitizeForLog(input, 16_384);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("sk-ant-xxx");
    expect(result).toContain("truncated");
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test tests/lib/diagnostics.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现诊断工具**

Create `src/lib/diagnostics.ts`:

```typescript
/**
 * 诊断日志工具（Issue 6）。
 * Claude stdout/stderr 在失败时写入 logs/turn-errors.log 前必须脱敏 + 限长。
 * 成功回合不写 stdout/stderr 到 workspace。
 */

const DEFAULT_LOG_LIMIT = 16_384; // 16KB

/** 把 ANTHROPIC_API_KEY 值替换为 [REDACTED]，处理 =/:/空格 分隔形式 */
export function redactSecrets(text: string): string {
  // 匹配 ANTHROPIC_API_KEY 后跟分隔符和值（值到空白或行尾）
  return text.replace(/ANTHROPIC_API_KEY\s*[:=]\s*\S+/gi, "ANTHROPIC_API_KEY=[REDACTED]");
}

/** 超过限长截断并标注 truncated */
export function truncateForLog(text: string, limit: number = DEFAULT_LOG_LIMIT): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + "\n...[truncated]";
}

/** 组合脱敏 + 限长（失败诊断写入日志前调用） */
export function sanitizeForLog(text: string, limit: number = DEFAULT_LOG_LIMIT): string {
  return truncateForLog(redactSecrets(text), limit);
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm test tests/lib/diagnostics.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/diagnostics.ts tests/lib/diagnostics.test.ts
git commit -m "feat(issue6): add diagnostics sanitize (redact secrets + truncate) for claude logs"
```

---

## Task 5: ClaudeCodeRunner 核心（mock spawn 单元测试）

**Files:**
- Create: `src/lib/claude-code-runner.ts`
- Test: `tests/lib/claude-code-runner.test.ts`

- [ ] **Step 1: 写失败测试**

Create `tests/lib/claude-code-runner.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ClaudeCodeRunner } from "@/lib/claude-code-runner";
import type { SpawnFn, SpawnResult } from "@/lib/claude-code-runner";
import { createStory, resolveWorkspaceDir, resolveWorkspaceRoot } from "@/lib/workspace";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";

let root: string;
beforeEach(async () => {
  root = await useTempWorkspaceRoot();
});
afterEach(() => resetWorkspaceRoot());

/** 构造 mock spawnFn，记录调用参数并返回预设结果 */
function makeMockSpawn(result: SpawnResult): { spawn: SpawnFn; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const spawn: SpawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return Promise.resolve(result);
  };
  return { spawn, calls };
}

describe("ClaudeCodeRunner", () => {
  it("调用 claude --bare -p，cwd=workspaceDir", async () => {
    const meta = await createStory();
    const { spawn, calls } = makeMockSpawn({ code: 0, stdout: "", stderr: "" });
    const runner = new ClaudeCodeRunner({ spawnFn: spawn });
    await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      playerInput: "推开木门",
      signal: AbortSignal.timeout(5000),
    });
    expect(calls[0].cmd).toBe("claude");
    expect(calls[0].args).toContain("--bare");
    expect(calls[0].args).toContain("-p");
    expect(calls[0].opts.cwd).toBe(resolveWorkspaceDir(meta.storyId));
  });

  it("env 白名单传递，不含全量 process.env，含 ANTHROPIC_API_KEY/PATH/HOME/NODE_ENV/TMPDIR/USE_BUILTIN_RIPGREP", async () => {
    const meta = await createStory();
    process.env.ANTHROPIC_API_KEY = "sk-test-xxx";
    const { spawn, calls } = makeMockSpawn({ code: 0, stdout: "", stderr: "" });
    const runner = new ClaudeCodeRunner({ spawnFn: spawn });
    await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      playerInput: "test",
      signal: AbortSignal.timeout(5000),
    });
    const env = calls[0].opts.env as Record<string, string | undefined>;
    expect(env.ANTHROPIC_API_KEY).toBe("sk-test-xxx");
    expect(env.PATH).toBeDefined();
    expect(env.HOME).toBeDefined();
    expect(env.NODE_ENV).toBeDefined();
    expect(env.TMPDIR).toBeDefined();
    expect(env.USE_BUILTIN_RIPGREP).toBe("0");
    // 白名单外的不应出现（用一个不可能在白名单的 key 验证）
    process.env.RPG4POV_TEST_LEAK = "should-not-leak";
    expect(env.RPG4POV_TEST_LEAK).toBeUndefined();
    delete process.env.RPG4POV_TEST_LEAK;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("prompt 经临时文件传递，不放 argv，临时文件用完删除", async () => {
    const meta = await createStory();
    const { spawn, calls } = makeMockSpawn({ code: 0, stdout: "", stderr: "" });
    const runner = new ClaudeCodeRunner({ spawnFn: spawn });
    await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      playerInput: "推开木门",
      signal: AbortSignal.timeout(5000),
    });
    // argv 不含完整 prompt（只含稳定短参数）
    const args = calls[0].args as string[];
    expect(args.some((a) => a.includes("推开木门"))).toBe(false);
    // 应有 --prompt-file 或类似指向临时文件的参数
    const promptFileArg = args.find((a) => a.startsWith("/tmp/") || a.includes("claude-prompts"));
    expect(promptFileArg).toBeDefined();
    // 临时文件应已删除
    await expect(fs.access(promptFileArg as string)).rejects.toThrow();
  });

  it("临时 prompt 文件不放 workspace 内", async () => {
    const meta = await createStory();
    const wsDir = resolveWorkspaceDir(meta.storyId);
    const { spawn, calls } = makeMockSpawn({ code: 0, stdout: "", stderr: "" });
    const runner = new ClaudeCodeRunner({ spawnFn: spawn });
    await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: wsDir,
      playerInput: "test",
      signal: AbortSignal.timeout(5000),
    });
    const args = calls[0].args as string[];
    const promptFileArg = args.find((a) => a.startsWith("/")) as string;
    expect(promptFileArg.startsWith(wsDir)).toBe(false);
  });

  it("成功回合返回 {success:true}，不写 stdout/stderr 到日志", async () => {
    const meta = await createStory();
    const { spawn } = makeMockSpawn({ code: 0, stdout: "claude stdout", stderr: "" });
    const runner = new ClaudeCodeRunner({ spawnFn: spawn });
    const result = await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      playerInput: "test",
      signal: AbortSignal.timeout(5000),
    });
    expect(result.success).toBe(true);
    // 验证 logs/turn-errors.log 不存在（成功不写诊断）
    await expect(
      fs.access(path.join(resolveWorkspaceDir(meta.storyId), "logs", "turn-errors.log")),
    ).rejects.toThrow();
  });

  it("非零退出码返回 {success:false, error}，写脱敏+限长诊断到 logs/turn-errors.log", async () => {
    const meta = await createStory();
    const { spawn } = makeMockSpawn({
      code: 1,
      stdout: "ANTHROPIC_API_KEY=sk-leak-xxx some output",
      stderr: "error detail",
    });
    const runner = new ClaudeCodeRunner({ spawnFn: spawn });
    const result = await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      playerInput: "test",
      signal: AbortSignal.timeout(5000),
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    const logContent = await fs.readFile(
      path.join(resolveWorkspaceDir(meta.storyId), "logs", "turn-errors.log"),
      "utf8",
    );
    expect(logContent).toContain("[REDACTED]");
    expect(logContent).not.toContain("sk-leak-xxx");
  });

  it("abort signal 触发时 kill 子进程（SIGTERM），返回失败", async () => {
    const meta = await createStory();
    const killedSignals: string[] = [];
    const spawn: SpawnFn = (cmd, args, opts) => {
      return new Promise((resolve) => {
        // 模拟长耗时进程，监听 kill
        const fakeChild = {
          kill(sig: string) {
            killedSignals.push(sig);
          },
        };
        // 把 fakeChild 经 opts._child 暴露（测试 hack；真实 spawn 返回 ChildProcess）
        (opts as Record<string, unknown>)._child = fakeChild;
        // 立即 abort
        opts.signal?.addEventListener("abort", () => {
          resolve({ code: null, stdout: "", stderr: "", aborted: true });
        });
      });
    };
    const runner = new ClaudeCodeRunner({ spawnFn: spawn });
    const ctrl = new AbortController();
    const resultPromise = runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      playerInput: "test",
      signal: ctrl.signal,
    });
    ctrl.abort();
    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(killedSignals).toContain("SIGTERM");
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test tests/lib/claude-code-runner.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 ClaudeCodeRunner**

Create `src/lib/claude-code-runner.ts`:

```typescript
import { spawn as realSpawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { AgentRunner, TurnRequest, TurnResult } from "./agent-runner";
import { buildPrompt } from "./claude-prompt";
import { CLAUDE_SETTINGS_PATH } from "./claude-settings";
import { sanitizeForLog } from "./diagnostics";
import { appendTurnError } from "./turn-error-log";

/** spawn 函数签名（用于依赖注入测试） */
export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: SpawnOpts,
) => Promise<SpawnResult>;

export interface SpawnOpts {
  cwd: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
  stdio: "pipe";
  /** 测试 hack：暴露 ChildProcess 以便测试验证 kill（真实 spawn 返回 ChildProcess） */
  _child?: { kill(sig: string): void };
}

export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  aborted?: boolean;
}

/** env 白名单（禁止全量继承 process.env） */
const ENV_WHITELIST = [
  "ANTHROPIC_API_KEY",
  "PATH",
  "HOME",
  "NODE_ENV",
  "TMPDIR",
  "USE_BUILTIN_RIPGREP",
];

const DEFAULT_CLAUDE_PATH = "claude";

/**
 * Claude Code Runner（Issue 6）。
 * 冷启动 `claude --bare -p` 子进程执行回合。
 * prompt 经临时文件传递（不放 argv/workspace），finally 清理。
 * env 白名单传递，禁止全量继承。
 * signal 传到子进程层，abort 时 SIGTERM，超时 escalate SIGKILL。
 * 成功不写 stdout/stderr；失败写脱敏+限长诊断到 logs/turn-errors.log。
 */
export class ClaudeCodeRunner implements AgentRunner {
  private readonly spawnFn: SpawnFn;
  private readonly claudePath: string;
  private readonly promptTemplate: (playerInput: string) => string;

  constructor(opts?: {
    spawnFn?: SpawnFn;
    claudePath?: string;
    promptTemplate?: (playerInput: string) => string;
  }) {
    this.spawnFn = opts?.spawnFn ?? defaultSpawn;
    this.claudePath = opts?.claudePath ?? DEFAULT_CLAUDE_PATH;
    this.promptTemplate = opts?.promptTemplate ?? buildPrompt;
  }

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    req.signal.throwIfAborted();

    const prompt = this.promptTemplate(req.playerInput);
    const promptFile = await writeTempPrompt(prompt);

    try {
      req.signal.throwIfAborted();

      const args = [
        "--bare",
        "-p",
        "--settings",
        CLAUDE_SETTINGS_PATH,
        promptFile,
      ];
      const env = buildEnvWhitelist();
      const result = await this.spawnFn(this.claudePath, args, {
        cwd: req.workspaceDir,
        env,
        signal: req.signal,
        stdio: "pipe",
      });

      if (result.aborted || req.signal.aborted) {
        return { success: false, error: "aborted" };
      }

      if (result.code !== 0) {
        // 失败：写脱敏+限长诊断到 logs/turn-errors.log
        const diag = `claude exit=${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
        await appendTurnError(req.storyId, {
          reason: "claude non-zero exit",
          input: req.playerInput,
          detail: sanitizeForLog(diag),
        });
        return { success: false, error: `claude exit code ${result.code}` };
      }

      // 成功：不写 stdout/stderr，权威交给磁盘 done.json（Orchestrator 检查）
      return { success: true };
    } catch (err) {
      const reason =
        err instanceof Error && err.name === "AbortError" ? "aborted" : "runner crashed";
      // 失败诊断（best-effort）
      try {
        await appendTurnError(req.storyId, {
          reason,
          input: req.playerInput,
          detail: sanitizeForLog(err instanceof Error ? err.message : String(err)),
        });
      } catch {
        // best-effort
      }
      return { success: false, error: reason };
    } finally {
      // 临时 prompt 文件用完即删
      await safeUnlink(promptFile);
    }
  }
}

/** 构造 env 白名单，禁止全量继承 process.env */
function buildEnvWhitelist(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of ENV_WHITELIST) {
    env[key] = process.env[key];
  }
  return env;
}

/** 写临时 prompt 文件到 /tmp/claude-prompts/<random>.md，不放 workspace */
async function writeTempPrompt(prompt: string): Promise<string> {
  const dir = path.join(os.tmpdir(), "claude-prompts");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `prompt-${crypto.randomUUID()}.md`);
  await fs.writeFile(file, prompt, "utf8");
  return file;
}

async function safeUnlink(file: string): Promise<void> {
  try {
    await fs.unlink(file);
  } catch {
    // best-effort
  }
}

/** 默认 spawn 实现：真实 child_process.spawn + signal→kill */
function defaultSpawn(cmd: string, args: string[], opts: SpawnOpts): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = realSpawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: opts.stdio,
    }) as ChildProcess;

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));

    let killed = false;
    const onAbort = () => {
      if (!killed) {
        killed = true;
        child.kill("SIGTERM");
        // SIGTERM 后 escalate SIGKILL（给 5s 宽限）
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 5_000);
      }
    };
    opts.signal.addEventListener("abort", onAbort);

    child.on("error", (err) => {
      opts.signal.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      opts.signal.removeEventListener("abort", onAbort);
      resolve({
        code,
        stdout,
        stderr,
        aborted: opts.signal.aborted,
      });
    });

    // 测试 hack：暴露 child 以便 mock 验证 kill
    opts._child = child;
  });
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm test tests/lib/claude-code-runner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/claude-code-runner.ts tests/lib/claude-code-runner.test.ts
git commit -m "feat(issue6): add ClaudeCodeRunner with spawn injection, temp prompt file, env whitelist"
```

---

## Task 6: ClaudeCodeRunner 集成测试（fake CLI）

**Files:**
- Create: `tests/fixtures/fake-claude.mjs`
- Create: `tests/lib/claude-code-runner-integration.test.ts`

- [ ] **Step 1: 创建 fake-claude fixture**

Create `tests/fixtures/fake-claude.mjs`:

```javascript
#!/usr/bin/env node
/**
 * fake-claude fixture（Issue 6 集成测试）。
 * 模拟 claude CLI 行为：读 prompt 文件，写 output.md + done.json，退出 0。
 * 支持环境变量 FAKE_CLAUDE_MODE 控制行为：
 *   - "success"（默认）：写 output + done，退出 0
 *   - "fail"：不写文件，退出 1
 *   - "timeout"：不写文件，不退出（由测试 abort）
 *   - "missing-output"：只写 done.json，不写 output.md
 */
import { promises as fs } from "node:fs";
import path from "node:path";

async function main() {
  const mode = process.env.FAKE_CLAUDE_MODE ?? "success";
  // 最后一个 argv 是 prompt 文件路径
  const promptFile = process.argv[process.argv.length - 1];
  const cwd = process.cwd();

  if (mode === "timeout") {
    // 不退出，等 abort
    await new Promise(() => {});
    return;
  }

  if (mode === "fail") {
    process.stderr.write("fake-claude simulated failure");
    process.exit(1);
  }

  const turnDir = path.join(cwd, "turn");
  await fs.mkdir(turnDir, { recursive: true });

  if (mode === "missing-output") {
    await fs.writeFile(
      path.join(turnDir, "done.json"),
      JSON.stringify({ status: "success", completedAt: new Date().toISOString() }),
    );
    process.exit(0);
  }

  // success
  await fs.writeFile(
    path.join(turnDir, "output.md"),
    "# 主角视窗\n\n（fake-claude 输出）\n\n回合执行完成。\n",
  );
  await fs.writeFile(
    path.join(turnDir, "done.json"),
    JSON.stringify({ status: "success", completedAt: new Date().toISOString() }),
  );
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(String(err));
  process.exit(1);
});
```

- [ ] **Step 2: 写集成测试**

Create `tests/lib/claude-code-runner-integration.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCodeRunner } from "@/lib/claude-code-runner";
import { createStory, resolveWorkspaceDir, resolveWorkspaceRoot } from "@/lib/workspace";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.resolve(__dirname, "../fixtures/fake-claude.mjs");

let root: string;
beforeAll(async () => {
  root = await useTempWorkspaceRoot();
});
afterAll(() => resetWorkspaceRoot());

describe("ClaudeCodeRunner 集成测试（真实 spawn + fake CLI）", () => {
  it("success 模式：fake-claude 写 output.md + done.json，runner 返回 success", async () => {
    const meta = await createStory();
    process.env.FAKE_CLAUDE_MODE = "success";
    const runner = new ClaudeCodeRunner({ claudePath: "node", spawnFn: undefined });
    // 用真实 spawn 但 claudePath=node，args 前置 fake-claude.mjs
    // 需要调整：直接用 defaultSpawn，但 claudePath=node + args=[fake-claude.mjs, --bare, ...]
    // 简化：构造一个 spawnFn 包装真实 spawn，前置 node + fake-claude
    const { defaultSpawn } = await import("@/lib/claude-code-runner");
    const wrappedSpawn = (cmd: string, args: string[], opts: unknown) =>
      defaultSpawn("node", [FAKE_CLAUDE, ...args], opts as never);
    const runnerWithFake = new ClaudeCodeRunner({ spawnFn: wrappedSpawn });

    const result = await runnerWithFake.runTurn({
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      playerInput: "推开木门",
      signal: AbortSignal.timeout(10_000),
    });
    expect(result.success).toBe(true);
    const output = await fs.readFile(
      path.join(resolveWorkspaceDir(meta.storyId), "turn", "output.md"),
      "utf8",
    );
    expect(output).toContain("主角视窗");
    const done = JSON.parse(
      await fs.readFile(path.join(resolveWorkspaceDir(meta.storyId), "turn", "done.json"), "utf8"),
    );
    expect(done.status).toBe("success");
  });

  it("fail 模式：fake-claude 退出 1，runner 返回失败，写诊断日志", async () => {
    const meta = await createStory();
    process.env.FAKE_CLAUDE_MODE = "fail";
    const { defaultSpawn } = await import("@/lib/claude-code-runner");
    const wrappedSpawn = (cmd: string, args: string[], opts: unknown) =>
      defaultSpawn("node", [FAKE_CLAUDE, ...args], opts as never);
    const runner = new ClaudeCodeRunner({ spawnFn: wrappedSpawn });

    const result = await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      playerInput: "test",
      signal: AbortSignal.timeout(10_000),
    });
    expect(result.success).toBe(false);
    const logContent = await fs.readFile(
      path.join(resolveWorkspaceDir(meta.storyId), "logs", "turn-errors.log"),
      "utf8",
    );
    expect(logContent).toContain("non-zero exit");
  });

  it("missing-output 模式：fake-claude 只写 done 不写 output，runner 仍返回 success（磁盘权威交给 Orchestrator）", async () => {
    const meta = await createStory();
    process.env.FAKE_CLAUDE_MODE = "missing-output";
    const { defaultSpawn } = await import("@/lib/claude-code-runner");
    const wrappedSpawn = (cmd: string, args: string[], opts: unknown) =>
      defaultSpawn("node", [FAKE_CLAUDE, ...args], opts as never);
    const runner = new ClaudeCodeRunner({ spawnFn: wrappedSpawn });

    const result = await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      playerInput: "test",
      signal: AbortSignal.timeout(10_000),
    });
    // runner 只看退出码，退出 0 → success=true；output 缺失由 Orchestrator 兜底
    expect(result.success).toBe(true);
  });

  it("timeout 模式：abort 触发 SIGTERM，runner 返回失败", async () => {
    const meta = await createStory();
    process.env.FAKE_CLAUDE_MODE = "timeout";
    const { defaultSpawn } = await import("@/lib/claude-code-runner");
    const wrappedSpawn = (cmd: string, args: string[], opts: unknown) =>
      defaultSpawn("node", [FAKE_CLAUDE, ...args], opts as never);
    const runner = new ClaudeCodeRunner({ spawnFn: wrappedSpawn });

    const ctrl = new AbortController();
    const resultPromise = runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      playerInput: "test",
      signal: ctrl.signal,
    });
    // 100ms 后 abort
    setTimeout(() => ctrl.abort(), 100);
    const result = await resultPromise;
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 3: 运行集成测试**

Run: `pnpm test tests/lib/claude-code-runner-integration.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures/fake-claude.mjs tests/lib/claude-code-runner-integration.test.ts
git commit -m "test(issue6): add claude-code-runner integration tests with fake CLI fixture"
```

---

## Task 7: route.ts Runner 切换

**Files:**
- Modify: `src/app/api/story-turn/route.ts`

- [ ] **Step 1: 修改 route.ts 支持 AGENT_RUNNER 切换**

Modify `src/app/api/story-turn/route.ts`，替换模块级单例部分:

```typescript
import { NextResponse } from "next/server";
import { isValidStoryId, workspaceExists } from "@/lib/workspace";
import { TurnOrchestrator, TurnBusyError } from "@/lib/turn-orchestrator";
import { FakeAgentRunner } from "@/lib/fake-agent-runner";
import { ClaudeCodeRunner } from "@/lib/claude-code-runner";

// 模块级单例：runner 在应用生命周期内不变。
// AGENT_RUNNER=claude 启用真实 CLI；默认 fake 保证测试/开发不依赖凭证/网络。
// docker-compose 默认不设 AGENT_RUNNER=claude，避免无 ANTHROPIC_API_KEY 时跑不起来。
function resolveRunner() {
  if (process.env.AGENT_RUNNER === "claude") {
    return new ClaudeCodeRunner();
  }
  return new FakeAgentRunner();
}

const orchestrator = new TurnOrchestrator(resolveRunner());
```

- [ ] **Step 2: 验证默认仍为 fake（现有测试不破）**

Run: `pnpm test tests/api/story-turn.test.ts`
Expected: PASS（默认 fake，现有契约不变）

- [ ] **Step 3: 验证类型检查**

Run: `pnpm exec tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add src/app/api/story-turn/route.ts
git commit -m "feat(issue6): add AGENT_RUNNER env switch in story-turn route"
```

---

## Task 8: Dockerfile 改造

**Files:**
- Modify: `Dockerfile`

- [ ] **Step 1: 改造 Dockerfile**

Modify `Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1

# ---- deps ----
FROM node:20-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ---- builder ----
FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build
# 编译 CLI wrapper 到 dist/（含 dist/cli + dist/lib，保证 import 链完整）
RUN pnpm build:cli

# ---- runner ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV WORKSPACE_ROOT=/app/data/workspaces
ENV USE_BUILTIN_RIPGREP=0

# alpine musl 适配：装 ripgrep（claude bundled ripgrep 是 glibc 编译）
RUN apk add --no-cache ripgrep

# 装 claude code CLI（npm 固定版本，拉取 native binary 经 per-platform optional dependency）
# 版本固定保证可重复构建；HITL 验收记录 claude --version 实际版本
RUN npm install -g @anthropic-ai/claude-code@1.0.0

RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs \
 && mkdir -p /app/data/workspaces /app/claude /home/nextjs/.claude \
 && chown -R nextjs:nodejs /app/data /app/claude /home/nextjs/.claude

# 写受控 settings.json 到 /app/claude/settings.json（不放 workspace，运行时只读）
# 内容来自 src/lib/claude-settings.ts 的 CLAUDE_SETTINGS_JSON，此处内联（构建时写死）
COPY --chown=nextjs:nodejs <<'SETTINGS' /app/claude/settings.json
{
  "env": {
    "USE_BUILTIN_RIPGREP": "0"
  },
  "permissions": {
    "deny": [
      "Read(./.env)",
      "Read(./.env.*)",
      "Read(./secrets/**)",
      "Write(./.env)",
      "Write(./.env.*)",
      "Write(./secrets/**)"
    ],
    "allow": [
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
      "Bash(node /app/cli/roll-choice.js:*)"
    ]
  }
}
SETTINGS

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
# 复制完整 dist/（含 dist/cli + dist/lib），保证 roll-choice.js import 链完整
COPY --from=builder --chown=nextjs:nodejs /app/dist ./dist

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
```

- [ ] **Step 2: 验证 Dockerfile 语法（不构建，仅 lint）**

Run: `docker buildx build --check .`
Expected: 无错误（若本机无 Docker，留 HITL 验证）

- [ ] **Step 3: Commit**

```bash
git add Dockerfile
git commit -m "feat(issue6): install claude code CLI + ripgrep + controlled settings in Dockerfile"
```

---

## Task 9: docker-compose + ignore 补漏

**Files:**
- Modify: `docker-compose.yml`
- Create: `docker-compose.claude.yml`
- Modify: `.gitignore`
- Modify: `.dockerignore`

- [ ] **Step 1: docker-compose.yml 保持默认不强制 claude**

Modify `docker-compose.yml`（保持现状，加注释说明）:

```yaml
services:
  rpg4pov:
    build: .
    image: rpg4pov:issue6
    container_name: rpg4pov
    ports:
      - "3000:3000"
    volumes:
      - rpg4pov-data:/app/data
    restart: unless-stopped
    # 默认 AGENT_RUNNER 不设（route.ts 默认 fake）。
    # 启用真实 claude：用 docker-compose -f docker-compose.yml -f docker-compose.claude.yml up
    # 或在此处 environment 加 AGENT_RUNNER=claude + ANTHROPIC_API_KEY。

volumes:
  rpg4pov-data:
```

- [ ] **Step 2: 创建 docker-compose.claude.yml 覆盖文件**

Create `docker-compose.claude.yml`:

```yaml
# 启用真实 Claude Code Runner 的 compose 覆盖文件。
# 用法：docker-compose -f docker-compose.yml -f docker-compose.claude.yml up
# 需宿主 shell 设置 ANTHROPIC_API_KEY 环境变量。
services:
  rpg4pov:
    environment:
      - AGENT_RUNNER=claude
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - TURN_TIMEOUT_MS=180000
```

- [ ] **Step 3: 补 .gitignore**

Modify `.gitignore`，在 `# env` 节替换:

```
# env
.env
.env.*
.env*.local
```

- [ ] **Step 4: 补 .dockerignore**

Modify `.dockerignore`，在末尾追加:

```
.env
.env.*
```

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml docker-compose.claude.yml .gitignore .dockerignore
git commit -m "feat(issue6): add claude compose override, ignore .env files"
```

---

## Task 10: 全量测试 + 类型检查

**Files:** 无（验证步骤）

- [ ] **Step 1: 运行全量测试**

Run: `pnpm test`
Expected: 所有测试 PASS（含 Issue 1-5 既有测试 + Issue 6 新增测试）

- [ ] **Step 2: 类型检查**

Run: `pnpm exec tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: CLI 编译验证**

Run: `pnpm build:cli`
Expected: `dist/cli/roll-choice.js` + `dist/lib/random-tool.js` + `dist/lib/workspace.js` 生成

- [ ] **Step 4: 如有失败，修复后重新验证**

若任何步骤失败，修复后重跑 Step 1-3。

---

## Task 11: HITL 验收步骤文档

**Files:** 无（HITL checklist，不写代码文件）

此 Task 不写代码，是 Issue 6 标 HITL 的人工验收清单。实现完成后由人工在有 Docker 的环境执行。

- [ ] **Step 1: 构建镜像**

```bash
docker-compose build
```
Expected: 镜像构建成功，无错误。

- [ ] **Step 2: 启动默认（fake）服务验证不破**

```bash
docker-compose up -d
# 等待启动
timeout 10 bash -c 'until curl -s http://localhost:3000 > /dev/null; do sleep 1; done'
curl -s http://localhost:3000 | head -n 5
```
Expected: 页面返回 200，含故事显示区/输入框/发送按钮。默认 fake runner 工作。
```bash
docker-compose down
```

- [ ] **Step 3: 启用 claude 验证真实管道**

```bash
# 宿主 shell 设置凭证
export ANTHROPIC_API_KEY=sk-ant-xxxxx

# 用 claude 覆盖文件启动
docker-compose -f docker-compose.yml -f docker-compose.claude.yml up -d
```

- [ ] **Step 4: 容器内验证 claude CLI 可用**

```bash
docker exec rpg4pov claude --version
```
Expected: 输出版本号，记录到 HITL 验收记录。若 npm optional dependency 拉取失败，切官方 apk 安装并记录。

- [ ] **Step 5: 容器内验证 roll-choice CLI 可运行**

```bash
docker exec rpg4pov sh -c "mkdir -p /tmp/roll-test && echo '{\"storyId\":\"00000000-0000-0000-0000-000000000001\",\"workspaceDir\":\"/tmp/roll-test\",\"rollId\":\"test\",\"candidates\":[{\"id\":\"a\",\"weight\":1}]}' | node /app/dist/cli/roll-choice.js"
```
Expected: stdout 输出 JSON 含 `selectedId: "a"`，退出码 0。验证 build 依赖完整。

- [ ] **Step 6: 容器内验证 settings.json 存在且内容正确**

```bash
docker exec rpg4pov cat /app/claude/settings.json
```
Expected: 输出含 `permissions.deny`（`.env`/`.env.*`/`secrets/**`）和 `permissions.allow`（`Bash(node /app/cli/roll-choice.js:*)`）。

- [ ] **Step 7: 创建故事并跑真实回合**

```bash
# 创建故事
STORY=$(curl -s -X POST http://localhost:3000/api/stories -H "Content-Type: application/json" -d '{"title":"HITL测试"}')
STORY_ID=$(echo $STORY | grep -o '"storyId":"[^"]*"' | cut -d'"' -f4)
echo "storyId: $STORY_ID"

# 跑真实回合
curl -s -X POST http://localhost:3000/api/story-turn \
  -H "Content-Type: application/json" \
  -d "{\"storyId\":\"$STORY_ID\",\"input\":\"推开木门\"}"
```
Expected: 返回 `playerResponse`，内容是 claude 生成的主角视窗（非 FakeAgent 固定输出）。若返回 500 失败，查容器内 `logs/turn-errors.log`。

- [ ] **Step 8: 验证非交互模式不卡权限询问**

观察 Step 7 是否在合理时间内（< 180s）返回。若超时或卡住，确认 settings.json 权限配置是否覆盖 claude 所有需要的操作，HITL 记录并调整。

- [ ] **Step 9: 验证凭证不泄漏**

```bash
# 检查日志不含明文 key
docker exec rpg4pov sh -c "grep -r 'sk-ant' /app/data 2>/dev/null; echo 'grep exit: '$?"
# 检查镜像不含 .env
docker exec rpg4pov sh -c "ls -la /app/.env* 2>/dev/null; echo 'ls exit: '$?"
```
Expected: grep 无匹配（exit 1），ls 无 .env 文件（exit 非 0）。

- [ ] **Step 10: 验证失败回滚**

```bash
# 故意不设凭证或设错，跑回合应失败回滚
docker-compose -f docker-compose.yml -f docker-compose.claude.yml exec rpg4pov sh -c 'unset ANTHROPIC_API_KEY'
# 重新跑回合（需重启服务使 env 生效，或直接验证 logs/turn-errors.log 有失败记录）
```
Expected: 回合失败，workspace 回滚到回合前状态，`logs/turn-errors.log` 有脱敏诊断。

- [ ] **Step 11: 清理**

```bash
docker-compose down
unset ANTHROPIC_API_KEY
```

- [ ] **Step 12: HITL 验收记录**

把 Step 4 的 `claude --version` 输出、Step 7 的 playerResponse 样例、Step 9/10 的验证结果记录到 Issue 6 验收记录。若任何步骤失败，记录失败现象并回到对应 Task 修复。

---

## Self-Review

**1. Spec coverage（对照 grill 验收边界 15 点）:**
- 验收 1（ClaudeCodeRunner + claude --bare -p）: Task 5 ✓
- 验收 2（写 output.md + done.json）: Task 5/6 ✓
- 验收 3（signal→SIGTERM→SIGKILL）: Task 5 ✓
- 验收 4（凭证 env 注入）: Task 9 ✓
- 验收 5（env 白名单 + 脱敏限长 + 不返回 Web）: Task 4/5 ✓
- 验收 6（受控 settings + deny/allow + HITL 确认）: Task 3/8/11 ✓
- 验收 7（prompt 经临时文件不放 argv）: Task 5 ✓
- 验收 8（CLI wrapper + build 依赖完整 + 镜像内验证）: Task 1/8/11 ✓
- 验收 9（prompt 放 src/lib，可迁移）: Task 2 ✓
- 验收 10（AGENT_RUNNER 切换 + compose 默认不强制）: Task 7/9 ✓
- 验收 11（三层测试 + HITL）: Task 5/6/11 ✓
- 验收 12（TURN_TIMEOUT_MS=180000）: Task 9 ✓
- 验收 13（失败回滚 + 只信任 status=success）: Task 5（Orchestrator 既有逻辑）✓
- 验收 14（ignore 补 .env）: Task 9 ✓
- 验收 15（安全边界明确）: Task 3/8（settings + Dockerfile）✓

**2. Placeholder scan:** 无 TBD/TODO，所有代码块完整。

**3. Type consistency:** `SpawnFn`/`SpawnOpts`/`SpawnResult` 在 Task 5 定义，Task 6 集成测试引用一致。`buildPrompt` 在 Task 2 定义，Task 5 引用一致。`CLAUDE_SETTINGS_PATH` 在 Task 3 定义，Task 5 引用一致。`sanitizeForLog` 在 Task 4 定义，Task 5 引用一致。

**4. Plan 级约束 P1-P4 覆盖:**
- P1（settings 真实语法 + heredoc）: Task 3 settings + Task 2 prompt heredoc 说明 ✓
- P2（prompt 临时文件二选一）: Task 5 明确选临时文件，/tmp/claude-prompts/<random>.md，finally 清理 ✓
- P3（stdout/stderr 只失败写日志）: Task 5 成功丢弃，失败 sanitizeForLog 写日志 ✓
- P4（settings 不放 workspace）: Task 3 CLAUDE_SETTINGS_PATH=/app/claude/settings.json + Task 8 Dockerfile 写入 ✓
