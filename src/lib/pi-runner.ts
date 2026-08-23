import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentRunner, TurnRequest, TurnResult } from "./agent-runner";
import { defaultSpawn, type SpawnFn, type SpawnOpts, type SpawnResult } from "./agent-spawn";
import { ensurePiConfig, resolvePiModel } from "./pi-config";
import {
  PI_INIT_SYSTEM_PROMPT,
  PI_TURN_SYSTEM_PROMPT,
  buildInitUserPrompt,
  buildTurnUserPrompt,
} from "./pi-prompt";
import { parseStateUpdate, applyStateUpdates, type RollDeclaration } from "./state-update";
import { applyInitWorkspaceBundle, parseInitWorkspaceBundle } from "./init-bundle";
import {
  captureWorkspaceManifest,
  findUnauthorizedWorkspaceChange,
  type WorkspaceManifest,
} from "./workspace-manifest";
import { generateRollPool, recordPoolRoll, type RollChoiceRng } from "./random-tool";
import { sanitizeForLog } from "./diagnostics";
import { TURN_OUTPUT_PLACEHOLDER, readRandomRollLines } from "./workspace";
import { validateTurnOutput } from "./turn-output";
import { readTurnInteractionRawLine } from "./turn-interaction";
import { sanitizeTurnInteraction } from "./interaction-schema";
import { beginTurnAttempt, publishTurnProgress } from "./turn-progress";
import { startPollWatcher, type PollWatchHandle } from "./poll-watcher";

/**
 * pi Coding Agent Runner（性能优化分支，task=turn/init 共用）。
 *
 * 执行模型（与 ClaudeCodeRunner 的 agent 自主读写不同）：
 * 1. 服务端预注入全部上下文（pi-prompt.ts），模型禁止读文件
 * 2. pi 单进程执行，模型并行写 3 个产物：output.md / interaction.json /
 *    state-update.md（状态变更合并单文件）
 * 3. 服务端后处理：解析合并 state-update → 随机判定申报落账 → 写 done.json
 *    （磁盘权威不变，由 Web 侧而非模型写入）→ orchestrator 走既有的校验/提交/回滚链路
 *
 * 可靠性装甲（实测 1/6 概率 qwen"口述不写盘"）：必需产物缺失或无效时自动重试
 * （PI_MAX_ATTEMPTS，默认 2，上限 3）。重试在同一快照窗口内，无半成品风险
 * （pi 未写任何文件或只写了部分文件，后续整体回滚/覆盖语义不受影响）。
 *
 * 随机判定（roll-choice，Issue 5）：pi 禁 bash，无法调 roll-choice CLI；
 * 等价物为预掷随机数池——服务端 crypto 预生成池注入 prompt，模型按序消耗
 * 并在 state-update.md 申报，服务端用自持样本重算权威结果落账审计日志
 * （random-tool.ts recordPoolRoll）。信任等级与 claude 路径对齐。
 */

const DEFAULT_PI_PATH = "pi";
const SIGKILL_GRACE_MS = 5_000;
/** 每回合预掷样本数（超时叙事权衡兜底，池在 runTurn 内跨重试固定） */
const ROLL_POOL_SIZE = 6;
/** 早退看门狗轮询间隔 */
const WATCH_INTERVAL_MS = 200;
/** Init agent may only mutate these three candidate artifacts. */
const INIT_ALLOWED_ARTIFACTS = [
  "turn/output.md",
  "turn/interaction.json",
  "turn/state-update.md",
] as const;

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

/** 早退开关（默认开；PI_EARLY_EXIT=0 关闭以便排查对照） */
function earlyExitEnabled(): boolean {
  return process.env.PI_EARLY_EXIT !== "0";
}

/** 三产物的 mtime 基线（attempt 开始前快照；null = 当时不存在） */
interface ArtifactMtimes {
  output: number | null;
  interaction: number | null;
  stateUpdate: number | null;
}

async function statArtifactMtimes(workspaceDir: string): Promise<ArtifactMtimes> {
  const turnDir = path.join(workspaceDir, "turn");
  const get = async (f: string): Promise<number | null> => {
    try {
      return (await fs.stat(path.join(turnDir, f))).mtimeMs;
    } catch {
      return null;
    }
  };
  return {
    output: await get("output.md"),
    interaction: await get("interaction.json"),
    stateUpdate: await get("state-update.md"),
  };
}

async function freshFileOk(
  file: string,
  baseline: number | null,
  validate: (raw: string) => boolean,
): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    // 新鲜度 = 严格新于 attempt 前基线（fs 时间戳对 fs 时间戳，规避
    // WSL2 下 mtime 滞后 Date.now() 数毫秒的时钟偏差）；基线 null = 原
    // 本不存在，任何落盘都算新。防止上一 attempt 残留触发误杀。
    if (baseline !== null && stat.mtimeMs <= baseline) return false;
    const raw = await fs.readFile(file, "utf8");
    return raw.trim() !== "" && validate(raw);
  } catch {
    return false;
  }
}

/** 三产物齐且形状合法（撕裂写防御）：output 首行契约 + interaction 可解析。 */
async function turnArtifactsComplete(
  workspaceDir: string,
  baselines: ArtifactMtimes,
  task: "turn" | "init" = "turn",
): Promise<boolean> {
  const turnDir = path.join(workspaceDir, "turn");
  const outputOk = await freshFileOk(path.join(turnDir, "output.md"), baselines.output, (raw) => {
    const first = raw.split("\n").find((l) => l.trim() !== "");
    return first?.trim() === "# 主角视窗" && raw.trim() !== TURN_OUTPUT_PLACEHOLDER.trim();
  });
  if (!outputOk) return false;
  const interactionOk = await freshFileOk(
    path.join(turnDir, "interaction.json"),
    baselines.interaction,
    (raw) => {
      try {
        JSON.parse(raw);
        return true;
      } catch {
        return false;
      }
    },
  );
  if (!interactionOk) return false;
  return freshFileOk(path.join(turnDir, "state-update.md"), baselines.stateUpdate, (raw) =>
    task === "init" ? parseInitWorkspaceBundle(raw).ok : true,
  );
}

/** mtime 严格新于基线；基线 null（attempt 前不存在）时任何存在都算新 */
async function mtimeFresherThan(file: string, baseline: number | null): Promise<boolean> {
  try {
    const mtime = (await fs.stat(file)).mtimeMs;
    return baseline === null || mtime > baseline;
  } catch {
    return false;
  }
}

/** 成功路径新鲜度门：output（首行契约+非占位）与 interaction（可解析）均新于基线 */
async function turnCoreArtifactsFresh(
  workspaceDir: string,
  baselines: ArtifactMtimes,
): Promise<boolean> {
  const turnDir = path.join(workspaceDir, "turn");
  const outputOk = await freshFileOk(path.join(turnDir, "output.md"), baselines.output, (raw) => {
    const first = raw.split("\n").find((l) => l.trim() !== "");
    return first?.trim() === "# 主角视窗" && raw.trim() !== TURN_OUTPUT_PLACEHOLDER.trim();
  });
  if (!outputOk) return false;
  return freshFileOk(path.join(turnDir, "interaction.json"), baselines.interaction, (raw) => {
    try {
      JSON.parse(raw);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * 早退看门狗：三产物落盘并校验通过即 SIGTERM pi，砍掉第二次 LLM 往返
 * （实测那趟只为输出"回合完成"23 token，却要 prefill 4.3k fresh + 整套
 * 网关往返，值 3-8s）。SIGTERM 后 pi 退出码非 0——由 fired 标记跳过
 * 退出码检查直接进产物校验；撕裂写（校验不过）按既有循环自愈重试。
 * 轮询骨架见 poll-watcher（与 claude done.json 看门狗共用）。
 */
function startEarlyExitWatcher(
  spawnOpts: SpawnOpts,
  workspaceDir: string,
  baselines: ArtifactMtimes,
  task: "turn" | "init",
): PollWatchHandle {
  return startPollWatcher(
    WATCH_INTERVAL_MS,
    () => turnArtifactsComplete(workspaceDir, baselines, task),
    () => spawnOpts._child?.kill("SIGTERM"),
    earlyExitEnabled(),
  );
}

export class PiRunner implements AgentRunner {
  private readonly spawnFn: SpawnFn;
  private readonly piPath: string;
  private readonly rollRng?: RollChoiceRng;

  constructor(opts?: { spawnFn?: SpawnFn; piPath?: string; rollRng?: RollChoiceRng }) {
    this.spawnFn = opts?.spawnFn ?? defaultSpawn;
    this.piPath = opts?.piPath ?? process.env.PI_PATH?.trim() ?? DEFAULT_PI_PATH;
    this.rollRng = opts?.rollRng;
  }

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    req.signal.throwIfAborted();
    await ensurePiConfig();
    const task = req.task ?? "turn";
    // Init has no random pool. The same runner still owns both execution
    // plans; only the prompt, artifact contract, and post-processing differ.
    const rollPool = task === "init" ? [] : generateRollPool(ROLL_POOL_SIZE, this.rollRng);
    const userPrompt =
      task === "init"
        ? await buildInitUserPrompt(req.workspaceDir, req.playerInput)
        : await buildTurnUserPrompt(req.workspaceDir, req.storyId, req.playerInput, rollPool);

    const args = [
      "-p",
      "--no-session",
      // json 事件流：toolcall_end 携带 write 参数原文，"叙事组合完成"时点
      // （实测全程 84% 处）先于进程退出暴露给前端（叙事先行显示）
      "--mode",
      "json",
      "--model",
      resolvePiModel(),
      // 工具面收窄到 write：契约本就禁止读/bash，列表里不存在比措辞约束更硬
      "--tools",
      "write",
      "--system-prompt",
      task === "init" ? PI_INIT_SYSTEM_PROMPT : PI_TURN_SYSTEM_PROMPT,
      userPrompt,
    ];

    const diagnostics: string[] = [];
    const maxAttempts = resolveMaxAttempts();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      req.signal.throwIfAborted();
      // 重试重开时相位回退到 generating——turn-progress 清空已发布预览，
      // 前端撤回叙事显示回到等待态；attempt 令牌发放后，旧 attempt 迟到
      // 的异步发布（泄密守卫读盘期间跨越了重试/终局）凭旧令牌被丢弃
      const attemptToken = beginTurnAttempt(req.storyId);

      const spawnOpts: SpawnOpts = {
        cwd: req.workspaceDir,
        env: buildPiEnv(),
        signal: req.signal,
        stdinData: "",
        stdio: ["pipe", "pipe", "pipe"],
        onStdoutLine: makePiEventHandler(req, attemptToken, task),
      };
      let clearKillTimer: (() => void) | undefined;
      const onAbort = () => {
        clearKillTimer = killChildGradual(spawnOpts._child);
      };
      req.signal.addEventListener("abort", onAbort);
      const artifactBaselines = await statArtifactMtimes(req.workspaceDir);
      let initManifestBefore: WorkspaceManifest | undefined;
      if (task === "init") {
        try {
          initManifestBefore = await captureWorkspaceManifest(req.workspaceDir);
        } catch (err) {
          req.signal.removeEventListener("abort", onAbort);
          return {
            success: false,
            error: "pi init workspace manifest failed",
            detail: sanitizeForLog(err instanceof Error ? err.message : String(err)),
          };
        }
      }
      const watcher = startEarlyExitWatcher(spawnOpts, req.workspaceDir, artifactBaselines, task);

      let result: SpawnResult | undefined;
      let spawnError: unknown = null;
      try {
        result = await this.spawnFn(this.piPath, args, spawnOpts);
      } catch (err) {
        // Keep the post-spawn manifest check ahead of exit/error handling: a
        // child may have written outside the init boundary before failing.
        spawnError = err;
      } finally {
        clearKillTimer?.();
      }
      watcher.stop();
      req.signal.removeEventListener("abort", onAbort);

      if (task === "init" && initManifestBefore) {
        let initManifestAfter: WorkspaceManifest;
        try {
          initManifestAfter = await captureWorkspaceManifest(req.workspaceDir);
        } catch (err) {
          return {
            success: false,
            error: "pi init workspace manifest failed",
            detail: `attempt ${attempt}: ${sanitizeForLog(
              err instanceof Error ? err.message : String(err),
            )}`,
          };
        }
        const unauthorized = findUnauthorizedWorkspaceChange(
          initManifestBefore,
          initManifestAfter,
          INIT_ALLOWED_ARTIFACTS,
        );
        if (unauthorized) {
          return {
            success: false,
            error: "pi init workspace write boundary violated",
            detail: `attempt ${attempt}: ${unauthorized}`,
          };
        }
      }

      if (spawnError !== null) {
        return {
          success: false,
          error: "pi runner crashed",
          detail: sanitizeForLog(spawnError instanceof Error ? spawnError.message : String(spawnError)),
        };
      }
      if (!result) {
        return { success: false, error: "pi runner crashed", detail: "spawn returned no result" };
      }

      if (result.aborted || req.signal.aborted) {
        return { success: false, error: "aborted", detail: sanitizeForLog(result.stderr).slice(0, 2000) };
      }
      if (result.code !== 0 && !watcher.fired) {
        diagnostics.push(
          `attempt ${attempt}: pi exit=${result.code}\n${sanitizeForLog(result.stdout + "\n" + result.stderr).slice(0, 2000)}`,
        );
        continue;
      }
      if (watcher.fired) {
        diagnostics.push(`attempt ${attempt}: early-exit fired (artifacts complete, skip final round-trip)`);
      }

      // 新鲜度守卫：口述失效模式（1/6 flake）下 pi 退出码 0 但不写盘，
      // turn/ 下残留的是上一回合产物——不拦会把旧回合 output/interaction
      // 当本回合提交（实测复现：连续两回合输出与上一回合一字不差）。
      // output/interaction 必须新于 attempt 前基线；早退看门狗 fire 过的
      // 天然新鲜，自然退出的在此复验。state-update 不设硬门（契约容许
      // 降级缺席），但旧文件不得重放——下方合并步骤单独校验。
      if (!watcher.fired && !(await turnCoreArtifactsFresh(req.workspaceDir, artifactBaselines))) {
        diagnostics.push(
          `attempt ${attempt}: pi exit=${result.code} but turn artifacts stale/missing (dictation flake?)`,
        );
        continue;
      }

      const output = await readOutputIfExists(req.workspaceDir);
      if (output === null) {
        // "口述不写盘"失效模式：重试（最后一次尝试的诊断由下方汇总）
        diagnostics.push(
          `attempt ${attempt}: pi exit=${result.code} but turn/output.md missing\n${sanitizeForLog(result.stdout).slice(0, 2000)}`,
        );
        continue;
      }

      if (task === "init") {
        // Init state-update is a complete workspace bundle, not the turn
        // APPEND/REPLACE delta format. It is validated in full before any
        // conceptual file is touched; invalid attempts are retried.
        const stateUpdatePath = path.join(req.workspaceDir, "turn", "state-update.md");
        if (!(await mtimeFresherThan(stateUpdatePath, artifactBaselines.stateUpdate))) {
          diagnostics.push(`attempt ${attempt}: init bundle missing or stale`);
          continue;
        }
        let rawBundle: string;
        try {
          rawBundle = await fs.readFile(stateUpdatePath, "utf8");
        } catch {
          diagnostics.push(`attempt ${attempt}: init bundle read failed`);
          continue;
        }
        const parsedBundle = parseInitWorkspaceBundle(rawBundle);
        if (!parsedBundle.ok) {
          diagnostics.push(`attempt ${attempt}: ${parsedBundle.error}`);
          continue;
        }
        try {
          await applyInitWorkspaceBundle(req.workspaceDir, parsedBundle.files);
        } catch (err) {
          const detail = sanitizeForLog(err instanceof Error ? err.message : String(err));
          // A valid bundle can still fail during the filesystem commit (for
          // example, a target path became a directory). Applying it may have
          // touched some conceptual files already, so never retry against the
          // same workspace. The orchestrator owns the snapshot rollback.
          return {
            success: false,
            error: "pi init bundle apply failed",
            detail: `attempt ${attempt}: init bundle apply failed: ${detail}`,
          };
        }
        await writeDoneMarker(req.workspaceDir);
        const notes: string[] = [];
        if (watcher.fired) notes.push("early-exit fired (skipped final round-trip)");
        return { success: true, detail: notes.length > 0 ? notes.join("; ") : undefined };
      }

      // 成功：合并状态更新 + 落账随机判定（均降级不致命）→ 服务端写 done.json
      const mergeDiags: string[] = [];
      let rolls: RollDeclaration[] = [];
      try {
        const stateUpdatePath = path.join(req.workspaceDir, "turn", "state-update.md");
        const stateFresh = await mtimeFresherThan(stateUpdatePath, artifactBaselines.stateUpdate);
        if (!stateFresh) {
          // 缺席（容许，降级）或残留旧文件（禁止重放——旧状态重复 APPEND
          // 会污染状态文件）。两种情况都跳过合并，只记诊断。
          mergeDiags.push("state-update.md absent or stale; skipped (degraded)");
        } else {
          const raw = await fs.readFile(stateUpdatePath, "utf8");
          const parsed = parseStateUpdate(raw);
          rolls = parsed.rolls;
          mergeDiags.push(...parsed.problems);
          const applied = await applyStateUpdates(req.workspaceDir, parsed.sections);
          mergeDiags.push(...applied.errors);
        }
      } catch {
        mergeDiags.push("state-update.md missing or unparseable; skipped (degraded)");
      }
      mergeDiags.push(...(await recordRollDeclarations(req, rollPool, rolls)));
      await writeDoneMarker(req.workspaceDir);
      const notes: string[] = [];
      if (watcher.fired) notes.push("early-exit fired (skipped final round-trip)");
      if (mergeDiags.length > 0) notes.push(`state-update notes: ${mergeDiags.join("; ").slice(0, 2000)}`);
      return {
        success: true,
        detail: notes.length > 0 ? notes.join("; ") : undefined,
      };
    }

    const missingArtifact = task === "init" ? "init artifact/bundle" : "turn output";
    return {
      success: false,
      error: `pi produced no ${missingArtifact} after ${maxAttempts} attempt(s)`,
      detail: sanitizeForLog(diagnostics.join("\n---\n")).slice(0, 4000),
    };
  }
}

/**
 * 落账随机数池消耗申报。严格按 R1,R2,… 顺序核对：乱序条目跳过且不消耗
 * 号位（防挑号——想用 R3 必须先申报消耗 R1/R2，且各自独立落账审计）；
 * 顺序正确但无法落账的（超池/校验失败）视为已消耗，只记诊断 note。
 * 单条失败一律降级，不影响回合成败。
 */
async function recordRollDeclarations(
  req: TurnRequest,
  rollPool: number[],
  rolls: RollDeclaration[],
): Promise<string[]> {
  const notes: string[] = [];
  let expected = 1;
  for (const decl of rolls) {
    if (decl.index !== expected) {
      notes.push(`roll skipped (out of order): R${decl.index}, expected R${expected}`);
      continue;
    }
    expected++;
    if (decl.index > rollPool.length) {
      notes.push(`roll skipped (pool exhausted): R${decl.index}`);
      continue;
    }
    try {
      const { result, mismatch } = await recordPoolRoll({
        storyId: req.storyId,
        workspaceDir: req.workspaceDir,
        rollId: decl.rollId,
        sample: rollPool[decl.index - 1],
        candidates: decl.candidates,
        ...(decl.declaredSelectedId !== undefined ? { declaredSelectedId: decl.declaredSelectedId } : {}),
      });
      if (mismatch) {
        notes.push(`roll ${decl.rollId}: declared ${decl.declaredSelectedId} but authoritative ${result.selectedId}`);
      }
    } catch (err) {
      notes.push(`roll ${decl.rollId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return notes;
}

/** pi json 事件流里 write 工具调用的最小形状（只取消费所需字段） */
interface PiToolCallBlock {
  type: string;
  name?: string;
  arguments?: { path?: unknown; content?: unknown };
}

/**
 * pi --mode json 事件流 → 叙事先行预览。
 * 只消费 toolcall_end（write 参数组合完成，早于磁盘写与服务端收尾）：
 * turn 的 output.md 就绪即发布叙事；init 等本 attempt 的 output 与
 * interaction 都就绪后再用后者做泄密指纹。交互建议始终先净化再发布。预览只是提前显示，
 * 权威仍是磁盘产物 + orchestrator 校验链。token 为 attempt 令牌——
 * 迟到发布（跨越重试/终局）由 turn-progress 丢弃。
 */
function makePiEventHandler(req: TurnRequest, token: number, task: "turn" | "init"): (line: string) => void {
  const initPreview: { output?: string; interactionFingerprints?: string[] } | undefined =
    task === "init" ? {} : undefined;

  return (line) => {
    let ev: {
      type?: string;
      assistantMessageEvent?: {
        type?: string;
        contentIndex?: number;
        partial?: { content?: PiToolCallBlock[] };
      };
    };
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    const a = ev.assistantMessageEvent;
    if (ev.type !== "message_update" || a?.type !== "toolcall_end") return;
    const blocks = a.partial?.content ?? [];
    // contentIndex = content 数组下标（thinking=0、toolCall=1..，实测稳定）；
    // 取不到时退化为最后一个块
    const block =
      (a.contentIndex !== undefined ? blocks[a.contentIndex] : undefined) ??
      blocks[blocks.length - 1];
    if (!block || block.type !== "toolCall" || block.name !== "write") return;
    const filePath = typeof block.arguments?.path === "string" ? block.arguments.path : "";
    const content = typeof block.arguments?.content === "string" ? block.arguments.content : "";
    const artifact = resolvePiPreviewArtifact(req.workspaceDir, filePath);
    if (artifact === "output") {
      if (initPreview) {
        initPreview.output = content;
        publishInitNarrativeWhenReady(req, initPreview, token);
      } else {
        void publishNarrativePreview(req, content, token);
      }
    } else if (artifact === "interaction") {
      const interactionFingerprints = buildInteractionFingerprints(content);
      if (initPreview) initPreview.interactionFingerprints = interactionFingerprints;
      publishInteractionPreview(req, content, token);
      if (initPreview) publishInitNarrativeWhenReady(req, initPreview, token);
    }
  };
}

function resolvePiPreviewArtifact(
  workspaceDir: string,
  filePath: string,
): "output" | "interaction" | null {
  if (filePath === "" || filePath.includes("\0")) return null;
  const normalizedInput = filePath.split(path.sep).join("/");
  if (!path.isAbsolute(filePath) && !["turn/output.md", "turn/interaction.json"].includes(normalizedInput)) {
    return null;
  }
  const relative = path.relative(path.resolve(workspaceDir), path.resolve(workspaceDir, filePath));
  const normalized = relative.split(path.sep).join("/");
  if (normalized === "turn/output.md") return "output";
  if (normalized === "turn/interaction.json") return "interaction";
  return null;
}

function buildInteractionFingerprints(content: string): string[] {
  try {
    const compact = JSON.stringify(JSON.parse(content));
    if (typeof compact !== "string" || compact.length === 0) return [];
    const raw = content.trim();
    return raw === compact ? [compact] : [raw, compact];
  } catch {
    return [];
  }
}

function publishInitNarrativeWhenReady(
  req: TurnRequest,
  preview: { output?: string; interactionFingerprints?: string[] },
  token: number,
): void {
  if (preview.output === undefined || !preview.interactionFingerprints?.length) return;
  void publishNarrativePreview(req, preview.output, token, preview.interactionFingerprints);
}

/** 叙事预览发布：首行契约 + 占位排除 + 与权威路径同源的泄密守卫，全过才发布 */
async function publishNarrativePreview(
  req: TurnRequest,
  content: string,
  token: number,
  interactionFingerprintsOverride?: readonly string[],
): Promise<void> {
  const trimmed = content.trim();
  const firstLine = trimmed.split("\n")[0]?.trim();
  if (firstLine !== "# 主角视窗" || trimmed === TURN_OUTPUT_PLACEHOLDER.trim()) return;
  try {
    const rollLines = await readRandomRollLines(req.storyId);
    let interactionFingerprints: string[];
    if (interactionFingerprintsOverride !== undefined) {
      interactionFingerprints = [...interactionFingerprintsOverride];
    } else {
      const interactionRawLine = await readTurnInteractionRawLine(req.storyId);
      interactionFingerprints = interactionRawLine ? [interactionRawLine] : [];
    }
    const problem = validateTurnOutput(
      trimmed,
      rollLines,
      interactionFingerprints,
    );
    if (problem) return;
    publishTurnProgress(req.storyId, { phase: "narrative-ready", narrative: trimmed }, token);
  } catch {
    // 预览是旁路，任何失败静默——权威路径不受影响
  }
}

/** 交互建议预览发布：可解析且净化通过才发布 */
function publishInteractionPreview(req: TurnRequest, content: string, token: number): void {
  try {
    const sanitized = sanitizeTurnInteraction(JSON.parse(content));
    if (sanitized) {
      publishTurnProgress(req.storyId, { phase: "interaction-ready", interaction: sanitized }, token);
    }
  } catch {
    // 不可解析交给权威路径
  }
}
