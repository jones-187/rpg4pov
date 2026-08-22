import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentRunner, TurnRequest, TurnResult } from "./agent-runner";
import { defaultSpawn, type SpawnFn, type SpawnOpts, type SpawnResult } from "./claude-code-runner";
import { ensurePiConfig, resolvePiModel } from "./pi-config";
import { PI_TURN_SYSTEM_PROMPT, buildTurnUserPrompt } from "./pi-prompt";
import { parseStateUpdate, applyStateUpdates } from "./state-update";
import { sanitizeForLog } from "./diagnostics";
import { TURN_OUTPUT_PLACEHOLDER } from "./workspace";

/**
 * pi Coding Agent Runner（性能优化分支，task=turn 专用）。
 *
 * 执行模型（与 ClaudeCodeRunner 的 agent 自主读写不同）：
 * 1. 服务端预注入全部上下文（pi-prompt.ts），模型禁止读文件
 * 2. pi 单进程执行，模型并行写 3 个产物：output.md / interaction.json /
 *    state-update.md（状态变更合并单文件）
 * 3. 服务端后处理：解析合并 state-update → 写 done.json（磁盘权威不变，
 *    由 Web 侧而非模型写入）→ orchestrator 走既有的校验/提交/回滚链路
 *
 * 可靠性装甲（实测 1/6 概率 qwen"口述不写盘"）：output.md 缺失时自动重试
 * （PI_MAX_ATTEMENTS，默认 2，上限 3）。重试在同一快照窗口内，无半成品风险
 * （pi 未写任何文件或只写了部分文件，后续整体回滚/覆盖语义不受影响）。
 *
 * 随机判定（roll-choice bash 工具）本分支不进入 pi 回合路径：pi prompt 禁用
 * bash 换取工具调用可靠性，判定以叙事化方式处理；init 路径（claude CLI）保留。
 */

const DEFAULT_PI_PATH = "pi";
const SIGKILL_GRACE_MS = 5_000;

/** 从 process.env 传递给 pi 的白名单（models.json 已含密钥，不传 token） */
const PI_ENV_WHITELIST = ["PATH", "HOME", "NODE_ENV", "TMPDIR"];

function buildPiEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of PI_ENV_WHITELIST) env[key] = process.env[key];
  return env;
}

function resolveMaxAttempts(): number {
  const raw = process.env.PI_MAX_ATTEMPTS;
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isFinite(parsed)) return 2;
  return Math.min(3, Math.max(1, Math.floor(parsed)));
}

/** 服务端权威写入 done.json（形状与 workspace.DoneMarker 一致） */
async function writeDoneMarker(workspaceDir: string): Promise<void> {
  await fs.writeFile(
    path.join(workspaceDir, "turn", "done.json"),
    JSON.stringify({ status: "success", completedAt: new Date().toISOString() }) + "\n",
  );
}

/**
 * 读取回合产物。占位残留（createStory 写入的模板）视同未写——
 * "口述不写盘"失效模式下模型一个文件都不落，不能让占位文件蒙混过关。
 */
async function readOutputIfExists(workspaceDir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(workspaceDir, "turn", "output.md"), "utf8");
    if (raw.trim() === "" || raw.trim() === TURN_OUTPUT_PLACEHOLDER.trim()) return null;
    return raw;
  } catch {
    return null;
  }
}

/** 渐进 kill：SIGTERM → 宽限 → SIGKILL。与 claude-code-runner 同策略。 */
function killChildGradual(child?: { kill(sig: string): void }): () => void {
  if (!child) return () => {};
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), SIGKILL_GRACE_MS);
  return () => clearTimeout(timer);
}

export class PiRunner implements AgentRunner {
  private readonly spawnFn: SpawnFn;
  private readonly piPath: string;

  constructor(opts?: { spawnFn?: SpawnFn; piPath?: string }) {
    this.spawnFn = opts?.spawnFn ?? defaultSpawn;
    this.piPath = opts?.piPath ?? process.env.PI_PATH?.trim() ?? DEFAULT_PI_PATH;
  }

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    req.signal.throwIfAborted();
    await ensurePiConfig();
    const userPrompt = await buildTurnUserPrompt(req.workspaceDir, req.storyId, req.playerInput);

    const args = [
      "-p",
      "--no-session",
      "--model",
      resolvePiModel(),
      "--system-prompt",
      PI_TURN_SYSTEM_PROMPT,
      userPrompt,
    ];

    const diagnostics: string[] = [];
    const maxAttempts = resolveMaxAttempts();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      req.signal.throwIfAborted();

      const spawnOpts: SpawnOpts = {
        cwd: req.workspaceDir,
        env: buildPiEnv(),
        signal: req.signal,
        stdinData: "",
        stdio: ["pipe", "pipe", "pipe"],
      };
      let clearKillTimer: (() => void) | undefined;
      const onAbort = () => {
        clearKillTimer = killChildGradual(spawnOpts._child);
      };
      req.signal.addEventListener("abort", onAbort);

      let result: SpawnResult;
      try {
        result = await this.spawnFn(this.piPath, args, spawnOpts);
      } catch (err) {
        req.signal.removeEventListener("abort", onAbort);
        return {
          success: false,
          error: "pi runner crashed",
          detail: sanitizeForLog(err instanceof Error ? err.message : String(err)),
        };
      } finally {
        clearKillTimer?.();
      }
      req.signal.removeEventListener("abort", onAbort);

      if (result.aborted || req.signal.aborted) {
        return { success: false, error: "aborted", detail: sanitizeForLog(result.stderr).slice(0, 2000) };
      }
      if (result.code !== 0) {
        diagnostics.push(
          `attempt ${attempt}: pi exit=${result.code}\n${sanitizeForLog(result.stdout + "\n" + result.stderr).slice(0, 2000)}`,
        );
        continue;
      }

      const output = await readOutputIfExists(req.workspaceDir);
      if (output === null) {
        // "口述不写盘"失效模式：重试（最后一次尝试的诊断由下方汇总）
        diagnostics.push(
          `attempt ${attempt}: pi exited 0 but turn/output.md missing\n${sanitizeForLog(result.stdout).slice(0, 2000)}`,
        );
        continue;
      }

      // 成功：合并状态更新（降级不致命）→ 服务端写 done.json
      const mergeDiags: string[] = [];
      try {
        const raw = await fs.readFile(path.join(req.workspaceDir, "turn", "state-update.md"), "utf8");
        const parsed = parseStateUpdate(raw);
        mergeDiags.push(...parsed.problems);
        const applied = await applyStateUpdates(req.workspaceDir, parsed.sections);
        mergeDiags.push(...applied.errors);
      } catch {
        mergeDiags.push("state-update.md missing or unparseable; skipped (degraded)");
      }
      await writeDoneMarker(req.workspaceDir);
      return {
        success: true,
        detail: mergeDiags.length > 0 ? `state-update notes: ${mergeDiags.join("; ").slice(0, 2000)}` : undefined,
      };
    }

    return {
      success: false,
      error: `pi produced no turn output after ${maxAttempts} attempt(s)`,
      detail: sanitizeForLog(diagnostics.join("\n---\n")).slice(0, 4000),
    };
  }
}
