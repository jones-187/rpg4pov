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
  /** 测试 hack：暴露 ChildProcess 以便 runTurn 在 abort 时 kill（真实 spawn 由 defaultSpawn 挂载） */
  _child?: { kill(sig: string): void };
}

export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  aborted?: boolean;
}

/** 从 process.env 传递的白名单 key（禁止全量继承 process.env） */
const ENV_WHITELIST = [
  // Anthropic 官方 API
  "ANTHROPIC_API_KEY",
  // 第三方 API 兼容（如 OpenRouter、Azure、自建代理）
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  // 系统环境
  "PATH",
  "HOME",
  "NODE_ENV",
  "TMPDIR",
];

/**
 * runner 对 claude 子进程的固定 env 配置（不从 process.env 取）。
 * USE_BUILTIN_RIPGREP=0：禁用 claude 内置 ripgrep，改用容器安装的 ripgrep。
 * 与 claude-settings.ts 的 settings.json env 双重保险。
 */
const RUNNER_FIXED_ENV: Record<string, string> = {
  USE_BUILTIN_RIPGREP: "0",
  SHELL: "/bin/bash", // claude CLI v2 需要 POSIX shell
};

const DEFAULT_CLAUDE_PATH = "claude";

/** SIGTERM 后 escalate SIGKILL 的宽限期（ms） */
const SIGKILL_GRACE_MS = 5_000;

/**
 * Claude Code Runner（Issue 6）。
 * 冷启动 `claude --bare -p` 子进程执行回合。
 *
 * **职责分层**：
 * - runTurn：signal→kill 策略（abort 时 SIGTERM，宽限后 SIGKILL），失败诊断写日志
 * - defaultSpawn：spawn + 收集 stdout/stderr + 挂 _child（不 kill）
 *
 * 这样 kill 逻辑集中在 runTurn，无论 spawnFn 是 defaultSpawn（生产）还是 mock（测试），
 * abort 时都能经 opts._child kill 子进程，便于单元测试验证。
 *
 * prompt 经临时文件传递（不放 argv/workspace），finally 清理。
 * env 白名单传递，禁止全量继承。
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
    // promptFile 在 try 外声明，确保 finally 可访问（writeTempPrompt 失败时为 undefined）
    let promptFile: string | undefined;

    // 构造 spawn opts，abort listener 通过 opts._child kill 子进程
    const spawnOpts: SpawnOpts = {
      cwd: req.workspaceDir,
      env: buildEnvWhitelist(),
      signal: req.signal,
      stdio: "pipe",
    };
    // 保存 killChildGradual 返回的 clear 函数，finally 中调用以避免 event loop 延迟退出
    let clearKillTimer: (() => void) | undefined;
    const onAbort = () => {
      clearKillTimer = killChildGradual(spawnOpts._child);
    };
    req.signal.addEventListener("abort", onAbort);

    try {
      req.signal.throwIfAborted();
      // prompt 经临时文件传递，然后作为 claude CLI 的位置参数传入
      // Claude CLI v2 -p 支持：stdin 管道或位置参数
      const promptFilePath = await writeTempPrompt(prompt);
      promptFile = promptFilePath;

      const args = [
        "-p", // 非交互模式
        "--output-format",
        "json",
        // 权限通过 --settings + --permission-mode auto 控制：
        // - settings.json 定义 permissions.allow/deny 规则（路径级精细控制）
        // - --permission-mode auto 使 settings 中的 allow 规则自动放行，无需人工确认
        "--permission-mode",
        "auto",
        "--settings",
        CLAUDE_SETTINGS_PATH,
        promptFilePath, // prompt 作为位置参数
      ];
      const result = await this.spawnFn(this.claudePath, args, spawnOpts);

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
      req.signal.removeEventListener("abort", onAbort);
      // 清理 SIGKILL escalate timer，避免 event loop 延迟 5s 退出
      clearKillTimer?.();
      // 临时 prompt 文件用完即删（writeTempPrompt 失败时 promptFile 为 undefined，跳过）
      if (promptFile) {
        await safeUnlink(promptFile);
      }
    }
  }
}

/**
 * 渐进 kill 子进程：先 SIGTERM，宽限后 escalate SIGKILL。
 * child 为 undefined 时 no-op（spawnFn 尚未挂载 _child）。
 *
 * @returns clear 函数，调用以清理 SIGKILL escalate timer，避免 event loop 延迟退出
 */
function killChildGradual(child?: { kill(sig: string): void }): () => void {
  if (!child) return () => {};
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), SIGKILL_GRACE_MS);
  return () => clearTimeout(timer);
}

/** 构造 claude 子进程 env：process.env 白名单 + runner 固定配置 */
function buildEnvWhitelist(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of ENV_WHITELIST) {
    env[key] = process.env[key];
  }
  return { ...env, ...RUNNER_FIXED_ENV };
}

/** 写临时 prompt 文件到 {tmpdir}/claude-prompts/<random>.md，不放 workspace */
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

/**
 * 默认 spawn 实现：真实 child_process.spawn + 收集 stdout/stderr + 挂 _child。
 * 不负责 kill（kill 策略由 runTurn 经 opts._child 执行）。
 */
export function defaultSpawn(
  cmd: string,
  args: string[],
  opts: SpawnOpts,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = realSpawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv,
      stdio: opts.stdio,
    }) as ChildProcess;

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));

    child.on("error", (err) => {
      reject(err);
    });
    child.on("close", (code) => {
      resolve({
        code,
        stdout,
        stderr,
        aborted: opts.signal.aborted,
      });
    });

    // 暴露 child 以便 runTurn 在 abort 时 kill（测试 hack 兼生产用）
    opts._child = { kill: (sig) => child.kill(sig as any) };
  });
}
