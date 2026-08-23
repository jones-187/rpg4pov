import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentRunner, RunnerTask, TurnRequest, TurnResult } from "./agent-runner";
import { defaultSpawn, type SpawnFn, type SpawnOpts, type SpawnResult } from "./agent-spawn";
import { buildPrompt, buildInitPrompt } from "./claude-prompt";
import { readInitSkeletonContext } from "./init-context";
import { CLAUDE_SETTINGS_PATH } from "./claude-settings";
import { sanitizeForLog } from "./diagnostics";
import { startPollWatcher, type PollWatchHandle } from "./poll-watcher";
import { resolveAgentModel } from "./agent-model";

/** 默认 prompt 选择：task=init 用初始化模板（预注入骨架文件），否则回合模板 */
async function defaultPromptTemplate(
  input: string,
  task: RunnerTask,
  workspaceDir: string,
): Promise<string> {
  return task === "init"
    ? buildInitPrompt(input, await readInitSkeletonContext(workspaceDir))
    : buildPrompt(input);
}

// Re-export the neutral seam for existing callers and tests. New runners should
// import it from agent-spawn directly.
export { defaultSpawn } from "./agent-spawn";
export type { SpawnFn, SpawnOpts, SpawnResult } from "./agent-spawn";

/** 从 process.env 传递的白名单 key（禁止全量继承 process.env） */
const ENV_WHITELIST = [
  // Anthropic 官方 API
  "ANTHROPIC_API_KEY",
  // 第三方 API 兼容（如 OpenRouter、Azure、自建代理）
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
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
 * 冷启动 `claude -p` 子进程执行回合。
 *
 * **职责分层**：
 * - runTurn：signal→kill 策略（abort 时 SIGTERM，宽限后 SIGKILL），失败诊断写日志
 * - defaultSpawn：spawn + 收集 stdout/stderr + 挂 _child（不 kill）
 *
 * 这样 kill 逻辑集中在 runTurn，无论 spawnFn 是 defaultSpawn（生产）还是 mock（测试），
 * abort 时都能经 opts._child kill 子进程，便于单元测试验证。
 *
 * prompt 经 stdin 传递（child.stdin.end(fullPrompt)），claude -p 从 stdin 读取。
 * 不再使用临时文件，避免 claude CLI 因 stdin pipe 无数据而等待 3s 超时。
 * env 白名单传递，禁止全量继承。
 * 成功不写 stdout/stderr；失败写脱敏+限长诊断到 logs/turn-errors.log。
 */
export class ClaudeCodeRunner implements AgentRunner {
  private readonly spawnFn: SpawnFn;
  private readonly claudePath: string;
  private readonly promptTemplate: (
    input: string,
    task: RunnerTask,
    workspaceDir: string,
  ) => string | Promise<string>;

  constructor(opts?: {
    spawnFn?: SpawnFn;
    claudePath?: string;
    /** 注入模板可只声明 input 参数（TS 少参数函数可赋值）；task/workspaceDir 仅默认模板使用 */
    promptTemplate?: (input: string, task: RunnerTask, workspaceDir: string) => string | Promise<string>;
  }) {
    this.spawnFn = opts?.spawnFn ?? defaultSpawn;
    this.claudePath = opts?.claudePath ?? DEFAULT_CLAUDE_PATH;
    this.promptTemplate = opts?.promptTemplate ?? defaultPromptTemplate;
  }

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    req.signal.throwIfAborted();

    const task: RunnerTask = req.task ?? "turn";
    const prompt = await this.promptTemplate(req.playerInput, task, req.workspaceDir);

    // 构造 spawn opts，abort listener 通过 opts._child kill 子进程
    const spawnOpts: SpawnOpts = {
      cwd: req.workspaceDir,
      env: buildEnvWhitelist(),
      signal: req.signal,
      stdinData: prompt,
      stdio: ["pipe", "pipe", "pipe"],
    };
    // 保存 killChildGradual 返回的 clear 函数，finally 中调用以避免 event loop 延迟退出
    let clearKillTimer: (() => void) | undefined;
    const onAbort = () => {
      clearKillTimer = killChildGradual(spawnOpts._child);
    };
    req.signal.addEventListener("abort", onAbort);

    // done.json 早退看门狗基线（spawn 前 fs 时戳快照；正常流程 orchestrator
    // 已 unlink done.json，基线为 null）。仅 init 任务启用——turn 路径生产
    // 走 Pi Runner，本 runner 的 turn 行为保持原样
    const doneBaseline = await statDoneMtime(req.workspaceDir);
    const watcher = startDoneWatcher(
      spawnOpts,
      req.workspaceDir,
      doneBaseline,
      earlyExitEnabled() && task === "init",
    );

    try {
      req.signal.throwIfAborted();

      const args = [
        "-p", // 非交互模式，从 stdin 读取 prompt
        "--model",
        resolveAgentModel(),
        "--output-format",
        "json",
        // 权限治理（性能优化分支实测修正：Issue 14 的 settings 路径规则
        // 在 claude CLI 2.1.140 + 第三方网关环境下对 Write 调用完全不匹配——
        // 相对/绝对/glob 形式的 allow 与 deny 均无效，default 模式因此全拒，
        // acceptEdits 又连 deny 都无视）：
        // - --tools=Read,Write 从工具集层面移除 Bash 等其余一切工具，
        //   init 任务只需读占位骨架 + 写概念文档，Bash 对模型不存在
        // - auto 模式自动放行 Read/Write（含绝对路径），不依赖规则匹配
        // - orchestrator 独占文件（turns/**、story.md、turn/input.md）的保护
        //   改由代码层强制：TurnOrchestrator 成功路径在提交前从快照恢复
        //   受保护路径（restoreProtectedPaths），比 CLI 规则更强且可测试
        "--permission-mode",
        "auto",
        "--tools=Read,Write",
        "--settings",
        CLAUDE_SETTINGS_PATH,
      ];
      const result = await this.spawnFn(this.claudePath, args, spawnOpts);

      if (result.aborted || req.signal.aborted) {
        return {
          success: false,
          error: "aborted",
          detail: sanitizeForLog(
            `aborted: signal=${req.signal.aborted}, result.aborted=${result.aborted}\n` +
              `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
          ),
        };
      }

      // 看门狗已开火：done.json 新鲜落盘且 status=success，claude 被 SIGTERM
      // （退出码非 0 是 kill 的预期结果）。跳过退出码检查——权威交给
      // orchestrator 的 done.json/output 校验链，fail-closed 不变
      if (result.code !== 0 && !watcher.fired) {
        const signalInfo = result.code === null ? " (killed by signal)" : "";
        return {
          success: false,
          error: `claude exit code ${result.code}${signalInfo}`,
          // 诊断信息通过 detail 返回，由 Orchestrator 在 restoreSnapshot 之后写入日志
          detail: sanitizeForLog(
            `claude exit=${result.code}${signalInfo}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
          ),
        };
      }

      // 成功：不写 stdout/stderr，权威交给磁盘 done.json（Orchestrator 检查）
      return { success: true };
    } catch (err) {
      const reason =
        err instanceof Error && err.name === "AbortError" ? "aborted" : "runner crashed";
      return {
        success: false,
        error: reason,
        detail: sanitizeForLog(err instanceof Error ? err.message : String(err)),
      };
    } finally {
      watcher.stop();
      req.signal.removeEventListener("abort", onAbort);
      // 清理 SIGKILL escalate timer，避免 event loop 延迟 5s 退出
      clearKillTimer?.();
    }
  }
}

/**
 * 渐进 kill 子进程：先 SIGTERM，宽限后 escalate SIGKILL。
 * child 为 undefined 时 no-op（spawnFn 尚未挂载 _child）。
 *
 * @returns clear 函数，调用以清理 SIGKILL escalate timer，避免 event loop 延迟 5s 退出
 */
function killChildGradual(child?: { kill(sig: string): void }): () => void {
  if (!child) return () => {};
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), SIGKILL_GRACE_MS);
  return () => clearTimeout(timer);
}

/** done.json 看门狗轮询间隔（ms） */
const DONE_WATCH_INTERVAL_MS = 200;

/** claude 路径早退开关（默认开；CLAUDE_EARLY_EXIT=0 关闭以便排查对照） */
function earlyExitEnabled(): boolean {
  return process.env.CLAUDE_EARLY_EXIT !== "0";
}

async function statDoneMtime(workspaceDir: string): Promise<number | null> {
  try {
    return (await fs.stat(path.join(workspaceDir, "turn", "done.json"))).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * done.json 早退看门狗（init 专用，P2 三刀之三）。
 * 时间解剖实测：claude 在 done.json 落盘后还会跑数十秒的自查/返工/告别
 * 陈词，用户全程盯着进度条。契约已改为"done.json 永远是最后一步"，故
 * done.json 新鲜落盘且 status=success 即 SIGTERM 砍掉 post-done 尾巴。
 * 新鲜度 = mtime 严格新于 spawn 前基线（fs 对 fs，规避时钟偏差与上回合
 * 残留误杀）。杀早了的内容缺陷由 orchestrator 的 output 校验 +
 * validateInitWorkspace 兜底（整轮回滚，fail-closed）。
 * 轮询骨架见 poll-watcher（与 pi 三产物看门狗共用）。
 */
function startDoneWatcher(
  spawnOpts: SpawnOpts,
  workspaceDir: string,
  baseline: number | null,
  enabled: boolean,
): PollWatchHandle {
  return startPollWatcher(
    DONE_WATCH_INTERVAL_MS,
    async () => {
      const donePath = path.join(workspaceDir, "turn", "done.json");
      const mtime = (await fs.stat(donePath)).mtimeMs;
      if (baseline !== null && mtime <= baseline) return false;
      const parsed = JSON.parse(await fs.readFile(donePath, "utf8")) as { status?: unknown };
      return parsed.status === "success";
    },
    () => spawnOpts._child?.kill("SIGTERM"),
    enabled,
  );
}

/** 构造 claude 子进程 env：process.env 白名单 + runner 固定配置 */
function buildEnvWhitelist(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of ENV_WHITELIST) {
    env[key] = process.env[key];
  }
  return { ...env, ...RUNNER_FIXED_ENV, ANTHROPIC_MODEL: resolveAgentModel() };
}
