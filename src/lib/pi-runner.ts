import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import type { AgentRunner, TurnRequest, TurnResult } from "./agent-runner";
import { defaultSpawn, type SpawnFn, type SpawnOpts, type SpawnResult } from "./agent-spawn";
import { ensurePiConfig, resolvePiModel } from "./pi-config";
import {
  PI_INIT_CONCEPTS_SYSTEM_PROMPT,
  PI_INIT_OPENING_SYSTEM_PROMPT,
  PI_TURN_SYSTEM_PROMPT,
  PI_SCENE_PLAN_SYSTEM_PROMPT,
  resolveTurnSystemPrompt,
  buildInitConceptsUserPrompt,
  buildInitOpeningUserPrompt,
  buildTurnUserPrompt,
} from "./pi-prompt";
import {
  applyFactLedgerUpdate,
  FACT_LEDGER_VERSION,
  type FactLedger,
} from "./fact-ledger";
import { parseStateUpdate, applyStateUpdates } from "./state-update";
import { applyInitWorkspaceBundle, parseInitWorkspaceBundle } from "./init-bundle";
import {
  captureWorkspaceManifest,
  findUnauthorizedWorkspaceChange,
  type WorkspaceManifest,
} from "./workspace-manifest";
import { recordPoolRoll, type RollChoiceRng } from "./random-tool";
import { bindTurnRolls, bindingRollContext, validateBoundRolls, type BoundTurnRoll } from "./turn-rolls";
import { sanitizeForLog } from "./diagnostics";
import {
  TURN_OUTPUT_PLACEHOLDER,
  readContinuityCard,
  readRandomRollLines,
  writeContinuityCard,
} from "./workspace";
import { validateTurnOutput } from "./turn-output";
import { readTurnInteractionRawLine } from "./turn-interaction";
import { sanitizeTurnInteraction } from "./interaction-schema";
import { beginTurnAttempt, publishTurnProgress } from "./turn-progress";
import { startPollWatcher, type PollWatchHandle } from "./poll-watcher";
import { parseScenePlan, buildSceneRenderContext, SCENE_RENDER_SYSTEM_PROMPT } from "./scene-plan";
import { createPiResponseCollector, parseResponseJson, parseResponseOutput, parseTurnResponse } from "./pi-response";
import { parsePublicSceneFromPlayer } from "./public-scene";

/**
 * pi Coding Agent Runner（性能优化分支，task=turn/init 共用）。
 *
 * 执行模型（与 ClaudeCodeRunner 的 agent 自主读写不同）：
 * 1. 服务端预注入全部上下文（pi-prompt.ts），模型禁止读文件
 * 2. turn 由 pi 返回一个完整 JSON，程序校验后统一写入；init 分为概念 Bundle 与 opening 两阶段，
 *    两阶段各有独立写白名单，避免开场叙事读取/泄漏隐藏设定。
 * 3. 服务端后处理：解析合并 state-update → 随机判定申报落账 → 写 done.json
 *    （磁盘权威不变，由 Web 侧而非模型写入）→ orchestrator 走既有的校验/提交/回滚链路
 *
 * 普通 turn 禁用全部模型工具，不再依赖模型写盘；完整响应缺失或无效时自动重试
 * （PI_MAX_ATTEMPTS，默认 2，上限 3）。重试在同一快照窗口内，无半成品风险
 * （pi 未写任何文件或只写了部分文件，后续整体回滚/覆盖语义不受影响）。
 *
 * 风险判定先提交候选请求，服务端随后抽样并绑定结果，再生成叙事；
 * 模型不接触样本。状态和随机确认严格验证后才写 done，失败交给 Orchestrator 回滚。
 */

const DEFAULT_PI_PATH = "pi";
const SIGKILL_GRACE_MS = 5_000;
/** 早退看门狗轮询间隔 */
const WATCH_INTERVAL_MS = 200;
/** Candidate artifact paths for each execution plan. */
const INIT_CONCEPT_ALLOWED_ARTIFACTS = ["turn/state-update.md"] as const;
const INIT_OPENING_ALLOWED_ARTIFACTS = ["turn/output.md", "turn/interaction.json"] as const;
type PiPhase = "turn" | "turn-plan" | "turn-render" | "init-concepts" | "init-opening";
const DEFAULT_PI_WRITE_BOUNDARY_EXTENSION_PATH = path.resolve(
  process.cwd(),
  "pi-extensions/write-boundary.ts",
);

/** 从 process.env 传递给 pi 的白名单（models.json 已含密钥，不传 token） */
const PI_ENV_WHITELIST = ["PATH", "HOME", "NODE_ENV", "TMPDIR"];

function buildPiEnv(allowedPaths: readonly string[]): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of PI_ENV_WHITELIST) env[key] = process.env[key];
  // This value is runner-owned. The model cannot widen the phase allowlist
  // through prompt text or by inheriting the parent process environment.
  env.PI_WRITE_ALLOWED_PATHS = allowedPaths.join(",");
  return env;
}

function resolveMaxAttempts(): number {
  const raw = process.env.PI_MAX_ATTEMPTS;
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isFinite(parsed)) return 2;
  return Math.min(3, Math.max(1, Math.floor(parsed)));
}

function resolvePiWriteBoundaryExtensionPath(): string {
  const configured = process.env.PI_WRITE_BOUNDARY_EXTENSION_PATH?.trim();
  return path.resolve(configured || DEFAULT_PI_WRITE_BOUNDARY_EXTENSION_PATH);
}

function resolvePiResponseExtensionPath(): string {
  return path.resolve(process.env.PI_RESPONSE_EXTENSION_PATH?.trim() || "pi-extensions/json-response.ts");
}

/**
 * The write boundary is a fail-closed startup prerequisite. The extension is
 * the pre-execution guard; Pi must never start without a readable copy of it.
 */
async function ensureReadableExtension(extensionPath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(extensionPath);
    if (!stat.isFile()) return null;
    await fs.access(extensionPath, fsConstants.R_OK);
    return extensionPath;
  } catch {
    return null;
  }
}

/** 服务端权威写入 done.json（形状与 workspace.DoneMarker 一致） */
async function writeDoneMarker(workspaceDir: string): Promise<void> {
  await fs.writeFile(
    path.join(workspaceDir, "turn", "done.json"),
    JSON.stringify({ status: "success", completedAt: new Date().toISOString() }) + "\n",
  );
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
  return (await readFreshFile(file, baseline, validate)) !== null;
}

async function readFreshFile(
  file: string,
  baseline: number | null,
  validate: (raw: string) => boolean,
): Promise<string | null> {
  try {
    const stat = await fs.stat(file);
    // 新鲜度 = 严格新于 attempt 前基线（fs 时间戳对 fs 时间戳，规避
    // WSL2 下 mtime 滞后 Date.now() 数毫秒的时钟偏差）；基线 null = 原
    // 本不存在，任何落盘都算新。防止上一 attempt 残留触发误杀。
    if (baseline !== null && stat.mtimeMs <= baseline) return null;
    const raw = await fs.readFile(file, "utf8");
    return raw.trim() !== "" && validate(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** 根据执行阶段检查早退所需的候选产物（撕裂写防御）。 */
async function turnArtifactsComplete(
  workspaceDir: string,
  baselines: ArtifactMtimes,
  phase: PiPhase = "turn",
): Promise<boolean> {
  const turnDir = path.join(workspaceDir, "turn");
  if (phase === "init-concepts") {
    return freshFileOk(
      path.join(turnDir, "state-update.md"),
      baselines.stateUpdate,
      (raw) => {
        const bundle = parseInitWorkspaceBundle(raw);
        if (!bundle.ok) return false;
        try { parsePublicSceneFromPlayer(bundle.files.find(file => file.path === "player.md")?.content ?? ""); return true; }
        catch { return false; }
      },
    );
  }
  if (phase === "init-opening") {
    return (await validateInitOpeningArtifacts(workspaceDir, baselines)).ok;
  }
  return false; // Response-only turns never finish from disk artifacts.
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

interface InitOpeningValidation {
  ok: boolean;
  problem?: string;
}

/**
 * Init Phase 2's final candidate gate. Both files must be fresh, interaction
 * must survive the public schema sanitizer, and output must pass the same
 * leak/shape validator used by Orchestrator before a Done Marker is written.
 */
async function validateInitOpeningArtifacts(
  workspaceDir: string,
  baselines: ArtifactMtimes,
): Promise<InitOpeningValidation> {
  const turnDir = path.join(workspaceDir, "turn");
  const output = await readFreshFile(path.join(turnDir, "output.md"), baselines.output, (raw) => {
    const first = raw.split("\n").find((line) => line.trim() !== "");
    return first?.trim() === "# 主角视窗" && raw.trim() !== TURN_OUTPUT_PLACEHOLDER.trim();
  });
  if (output === null) return { ok: false, problem: "opening output missing, stale, or malformed" };

  const interactionRaw = await readFreshFile(
    path.join(turnDir, "interaction.json"),
    baselines.interaction,
    (raw) => {
      try {
        return sanitizeTurnInteraction(JSON.parse(raw)) !== null;
      } catch {
        return false;
      }
    },
  );
  if (interactionRaw === null) {
    return { ok: false, problem: "opening interaction missing, stale, or invalid" };
  }

  const problem = validateTurnOutput(output, [], buildInteractionFingerprints(interactionRaw));
  return problem ? { ok: false, problem } : { ok: true };
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
  phase: PiPhase,
): PollWatchHandle {
  return startPollWatcher(
    WATCH_INTERVAL_MS,
    () => turnArtifactsComplete(workspaceDir, baselines, phase),
    () => spawnOpts._child?.kill("SIGTERM"),
    earlyExitEnabled(),
  );
}

interface PiAttemptResult {
  result?: SpawnResult;
  spawnError?: unknown;
  watcherFired: boolean;
  unauthorized?: string;
  manifestError?: unknown;
  artifactBaselines: ArtifactMtimes;
  responseText?: string;
  responseError?: string;
}

function findUnsupportedWorkspaceEntry(manifest: WorkspaceManifest): string | null {
  for (const [relative, entry] of manifest) {
    if (entry.kind === "symlink" || entry.kind === "other") {
      return `pre-existing ${entry.kind}: ${relative}`;
    }
  }
  return null;
}

/** Run one phase attempt and perform the post-spawn manifest check first. */
async function executePiAttempt(input: {
  req: TurnRequest;
  spawnFn: SpawnFn;
  piPath: string;
  args: string[];
  phase: PiPhase;
  allowedPaths: readonly string[];
  token: number;
  response?: boolean;
}): Promise<PiAttemptResult> {
  const { req, spawnFn, piPath, args, phase, allowedPaths, token } = input;
  const artifactBaselines = await statArtifactMtimes(req.workspaceDir);
  let manifestBefore: WorkspaceManifest | undefined;
  {
    try {
      manifestBefore = await captureWorkspaceManifest(req.workspaceDir);
    } catch (err) {
      return { artifactBaselines, watcherFired: false, manifestError: err };
    }
  }

  const collector = input.response ? createPiResponseCollector() : undefined;
  const spawnOpts: SpawnOpts = {
    cwd: req.workspaceDir,
    env: buildPiEnv(allowedPaths),
    signal: req.signal,
    stdinData: "",
    stdio: ["pipe", "pipe", "pipe"],
    // Candidates are not player-visible until Orchestrator commits the whole turn.
    onStdoutLine: collector ? collector.onLine : process.env.PI_UNCOMMITTED_PREVIEW === "1" && phase !== "turn-plan" && phase !== "turn-render" ? makePiEventHandler(req, token, phase) : undefined,
  };
  let clearKillTimer: (() => void) | undefined;
  const onAbort = () => {
    clearKillTimer = killChildGradual(spawnOpts._child);
  };
  req.signal.addEventListener("abort", onAbort);
  const watcher = input.response ? { stop() {}, fired: false } : startEarlyExitWatcher(spawnOpts, req.workspaceDir, artifactBaselines, phase);

  let result: SpawnResult | undefined;
  let spawnError: unknown;
  try {
    result = await spawnFn(piPath, args, spawnOpts);
  } catch (err) {
    spawnError = err;
  } finally {
    clearKillTimer?.();
    watcher.stop();
    req.signal.removeEventListener("abort", onAbort);
  }

  let unauthorized: string | undefined;
  let manifestError: unknown;
  if (manifestBefore) {
    try {
      const manifestAfter = await captureWorkspaceManifest(req.workspaceDir);
      unauthorized = findUnauthorizedWorkspaceChange(manifestBefore, manifestAfter, allowedPaths) ?? undefined;
    } catch (err) {
      manifestError = err;
    }
  }
  let responseText: string | undefined;
  let responseError: string | undefined;
  if (collector && result) {
    try { responseText = collector.finish(result.stdout); }
    catch (error) { responseError = String(error); }
  }
  return {
    result,
    spawnError,
    watcherFired: watcher.fired,
    unauthorized,
    manifestError,
    artifactBaselines,
    responseText,
    responseError,
  };
}

function buildPiArgs(
  extensionPath: string,
  systemPrompt: string,
  userPrompt: string,
): string[] {
  return [
    "-p",
    "--no-session",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--mode",
    "json",
    "--provider",
    "newapi",
    "--model",
    resolvePiModel(),
    "--tools",
    "write",
    "--no-extensions",
    "--extension",
    extensionPath,
    "--system-prompt",
    systemPrompt,
    userPrompt,
  ];
}

function buildResponseArgs(systemPrompt: string, userPrompt: string): string[] {
  return ["-p", "--no-session", "--no-tools", "--no-extensions", "--no-context-files",
    "--extension", resolvePiResponseExtensionPath(),
    "--no-skills", "--no-prompt-templates", "--mode", "json", "--provider", "newapi-response",
    // Pi 0.73.1 的最高合法档名是 xhigh；对 DeepSeek 即产品侧 max 档。
    "--thinking", "xhigh", "--model", resolvePiModel(),
    "--system-prompt", systemPrompt, userPrompt];
}

export class PiRunner implements AgentRunner {
  private readonly spawnFn: SpawnFn;
  private readonly piPath: string;
  private readonly rollRng?: RollChoiceRng;
  private readonly separateScene: boolean;
  private readonly experimentalFactLedger?: FactLedger;
  private readonly publicContinuityCard: boolean;

  constructor(opts?: {
    spawnFn?: SpawnFn;
    piPath?: string;
    rollRng?: RollChoiceRng;
    experimentalSceneSeparation?: boolean;
    experimentalFactLedger?: FactLedger;
    publicContinuityCard?: boolean;
  }) {
    this.spawnFn = opts?.spawnFn ?? defaultSpawn;
    this.piPath = opts?.piPath ?? process.env.PI_PATH?.trim() ?? DEFAULT_PI_PATH;
    this.rollRng = opts?.rollRng;
    this.separateScene = opts?.experimentalSceneSeparation ?? false;
    this.experimentalFactLedger = opts?.experimentalFactLedger;
    this.publicContinuityCard = opts?.publicContinuityCard ?? false;
    if (this.publicContinuityCard && (this.separateScene || this.experimentalFactLedger)) {
      throw new Error("public continuity card cannot be combined with experimental fact ledger injection or scene separation");
    }
  }

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    req.signal.throwIfAborted();
    await ensurePiConfig();
    const task = req.task ?? "turn";
    if (task === "init") {
      const extension = await ensureReadableExtension(resolvePiWriteBoundaryExtensionPath());
      if (!extension) return { success: false, error: "pi write boundary extension unavailable", detail: `required readable extension: ${resolvePiWriteBoundaryExtensionPath()}` };
      return this.runInitPhases(req, extension);
    }

    if (!await ensureReadableExtension(resolvePiResponseExtensionPath())) {
      return { success: false, error: "pi JSON response extension unavailable" };
    }

    let initialManifest: WorkspaceManifest;
    try {
      initialManifest = await captureWorkspaceManifest(req.workspaceDir);
    } catch (err) {
      return {
        success: false,
        error: "pi turn workspace manifest failed",
        detail: sanitizeForLog(err instanceof Error ? err.message : String(err)),
      };
    }
    const unsupportedEntry = findUnsupportedWorkspaceEntry(initialManifest);
    if (unsupportedEntry !== null) {
      return {
        success: false,
        error: "pi turn workspace write boundary violated",
        detail: unsupportedEntry,
      };
    }

    let currentLedger: FactLedger | null = null;
    if (this.publicContinuityCard) {
      try {
        currentLedger = await readContinuityCard(req.storyId);
      } catch (err) {
        return {
          success: false,
          error: "public continuity card read failed",
          detail: sanitizeForLog(err instanceof Error ? err.message : String(err)).slice(0, 2000),
        };
      }
    }
    const ledger = currentLedger ?? {
      version: FACT_LEDGER_VERSION,
      events: [],
      knowledgeBoundaries: [],
    };

    const userPrompt = await buildTurnUserPrompt(
      req.workspaceDir,
      req.storyId,
      req.playerInput,
      this.publicContinuityCard ? ledger : this.experimentalFactLedger,
      this.publicContinuityCard,
    );
    let boundRolls: BoundTurnRoll[] | undefined;

    const diagnostics: string[] = [];
    const maxAttempts = resolveMaxAttempts();

    let attemptsRemaining = maxAttempts;
    for (let attempt = 1; attemptsRemaining > 0; attempt++) {
      attemptsRemaining--;
      req.signal.throwIfAborted();
      // 重试重开时相位回退到 generating——turn-progress 清空已发布预览，
      // 前端撤回叙事显示回到等待态；attempt 令牌发放后，旧 attempt 迟到
      // 的异步发布（泄密守卫读盘期间跨越了重试/终局）凭旧令牌被丢弃
      const attemptToken = beginTurnAttempt(req.storyId);

      const attemptResult = await executePiAttempt({
        req,
        spawnFn: this.spawnFn,
        piPath: this.piPath,
        args: buildResponseArgs(
          this.separateScene
            ? PI_SCENE_PLAN_SYSTEM_PROMPT
            : resolveTurnSystemPrompt(this.publicContinuityCard),
          [userPrompt, boundRolls ? bindingRollContext(boundRolls) : "", diagnostics.length ? `上次完整响应未通过，请修正：${diagnostics.at(-1)}` : ""].join("\n\n")),
        phase: this.separateScene ? "turn-plan" : "turn",
        allowedPaths: [],
        token: attemptToken,
        response: true,
      });
      const { result, spawnError } = attemptResult;

      if (attemptResult.manifestError || attemptResult.unauthorized) {
        return { success: false, error: "pi turn workspace write boundary violated", detail: sanitizeForLog(String(attemptResult.unauthorized ?? attemptResult.manifestError)) };
      }

      if (spawnError !== undefined) {
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
      if (attemptResult.responseError || !attemptResult.responseText) {
        diagnostics.push(`attempt ${attempt}: ${attemptResult.responseError ?? "complete response missing"}`);
        continue;
      }
      let value: unknown;
      try { value = parseResponseJson(attemptResult.responseText); }
      catch (error) { diagnostics.push(`attempt ${attempt}: ${String(error)}`); continue; }
      if (value && typeof value === "object" && (value as { kind?: unknown }).kind === "roll-request") {
        if (boundRolls) return { success: false, error: "random candidates already bound" };
        let requestRaw: string;
        let nextBoundRolls: BoundTurnRoll[];
        try {
          const request = parseTurnResponse(attemptResult.responseText);
          if (request.kind !== "roll-request") throw new Error("invalid random request");
          requestRaw = JSON.stringify({ rolls: request.rolls });
          nextBoundRolls = bindTurnRolls(requestRaw, req.storyId, req.workspaceDir, this.rollRng);
        } catch (err) {
          diagnostics.push(`attempt ${attempt}: invalid roll request: ${sanitizeForLog(String(err))}`);
          continue;
        }
        try {
          await fs.writeFile(path.join(req.workspaceDir, "turn/roll-request.json"), requestRaw);
        } catch (err) {
          return {
            success: false,
            error: "random request persistence failed",
            detail: sanitizeForLog(String(err)).slice(0, 2000),
          };
        }
        boundRolls = nextBoundRolls;
        // Resolving a valid request is a phase transition, not a failed attempt.
        attemptsRemaining = maxAttempts;
        continue;
      }

      if (result.code !== 0) {
        diagnostics.push(
          `attempt ${attempt}: pi exit=${result.code}\n${sanitizeForLog(result.stdout + "\n" + result.stderr).slice(0, 2000)}`,
        );
        continue;
      }

      let candidate: {
        output: string;
        interaction: import("./interaction-schema").TurnInteraction;
        stateUpdate: string;
        factLedgerUpdate?: unknown;
      };
      if (this.separateScene) {
        try {
          const scene = parseScenePlan(JSON.stringify(value));
          const updates = parseStateUpdate(scene.stateUpdate);
          if (updates.problems.length) throw new Error(updates.problems.join("; "));
          validateBoundRolls(boundRolls ?? [], updates.rolls);
          const renderContext = await buildSceneRenderContext(req.workspaceDir, scene);
          let output: string | undefined;
          for (let renderAttempt = 0; renderAttempt < maxAttempts; renderAttempt++) {
            req.signal.throwIfAborted();
            const rendering = await executePiAttempt({ req, spawnFn: this.spawnFn, piPath: this.piPath,
              args: buildResponseArgs(SCENE_RENDER_SYSTEM_PROMPT, renderContext),
              phase: "turn-render", allowedPaths: [], response: true, token: beginTurnAttempt(req.storyId) });
            if (rendering.unauthorized || rendering.manifestError || rendering.spawnError || req.signal.aborted) throw new Error("scene rendering failed or crossed write boundary");
            if (rendering.result && !rendering.result.aborted && rendering.result.code === 0 && rendering.responseText) {
              try {
                const rendered = parseResponseJson(rendering.responseText) as Record<string, unknown>;
                if (!rendered || rendered.kind !== "render" || Object.keys(rendered).some(k => !["kind", "output"].includes(k)) || typeof rendered.output !== "string") throw new Error("invalid render response");
                const prose = parseResponseOutput(rendered.output);
                const problem = validateTurnOutput(prose, []);
                if (problem) throw new Error(problem);
                output = prose;
                break;
              } catch { /* Retry rendering without replanning or resampling. */ }
            }
          }
          if (!output) throw new Error("scene rendering produced no valid output");
          candidate = { output, stateUpdate: scene.stateUpdate, interaction: scene.interaction };
          await fs.writeFile(path.join(req.workspaceDir, "turn/scene-plan.json"), JSON.stringify(scene));
        } catch (err) {
          return { success: false, error: "experimental scene turn failed", detail: sanitizeForLog(String(err)) };
        }
      } else {
        try {
          const parsed = parseTurnResponse(attemptResult.responseText, {
            factLedgerUpdate: this.publicContinuityCard ? "required" : "forbidden",
          });
          if (parsed.kind !== "turn") throw new Error("expected complete turn");
          candidate = parsed;
        } catch (error) { diagnostics.push(`attempt ${attempt}: ${String(error)}`); continue; }
      }

      // Validate all candidate changes before committing any state or audit log.
      let parsedState: ReturnType<typeof parseStateUpdate>;
      let interactionRaw: string;
      let nextLedger: FactLedger | undefined;
      const raw = candidate.stateUpdate;
      try {
        parsedState = parseStateUpdate(raw);
        if (parsedState.problems.length) throw new Error(parsedState.problems.join("; "));
        validateBoundRolls(boundRolls ?? [], parsedState.rolls);
        interactionRaw = JSON.stringify(candidate.interaction);
        const problem = validateTurnOutput(candidate.output, await readRandomRollLines(req.storyId), [
          ...buildInteractionFingerprints(interactionRaw),
          ...parsedState.rolls.flatMap((roll) => [
            JSON.stringify(roll),
            `R${roll.index}: rollId=${roll.rollId} candidates=${roll.candidates.map((c) => `${c.id}:${c.weight}`).join(",")} → ${roll.declaredSelectedId}`,
          ]),
          ...raw.split("\n").map((line) => line.trim()).filter((line) => /^R\d+:/.test(line)),
        ]);
        if (problem) throw new Error(problem);
      } catch (err) {
        return {
          success: false,
          error: "turn candidate validation or commit failed",
          detail: sanitizeForLog(String(err)).slice(0, 2000),
        };
      }
      if (this.publicContinuityCard) {
        try {
          nextLedger = applyFactLedgerUpdate(ledger, candidate.factLedgerUpdate);
        } catch (err) {
        diagnostics.push(`attempt ${attempt}: ${sanitizeForLog(String(err)).slice(0, 2000)}`);
        continue;
        }
      }

      // From this point onward an I/O failure may follow partial writes, so it
      // must return to the orchestrator for whole-workspace rollback.
      try {
        const stateUpdatePath = path.join(req.workspaceDir, "turn", "state-update.md");
        const applied = await applyStateUpdates(req.workspaceDir, parsedState.sections);
        if (applied.errors.length) {
          // Returned validation errors guarantee zero writes. Only this case
          // may regenerate against the same state and frozen random outcomes.
          // Thrown I/O errors can follow partial writes and must roll back.
          if (attemptsRemaining > 0) {
            diagnostics.push(`attempt ${attempt}: ${sanitizeForLog(applied.errors.join("; ")).slice(0, 2000)}`);
            continue;
          }
          throw new Error(applied.errors.join("; "));
        }
        await fs.writeFile(stateUpdatePath, raw);
        await fs.writeFile(path.join(req.workspaceDir, "turn/output.md"), candidate.output);
        await fs.writeFile(path.join(req.workspaceDir, "turn/interaction.json"), interactionRaw);
        if (this.publicContinuityCard && nextLedger) {
          await writeContinuityCard(req.storyId, nextLedger);
        }
        for (const roll of boundRolls ?? []) {
          await recordPoolRoll({ storyId: req.storyId, workspaceDir: req.workspaceDir, ...roll, declaredSelectedId: roll.selectedId });
        }
      } catch (err) {
        // Never retry after state application: Orchestrator restores the snapshot.
        return { success: false, error: "turn candidate validation or commit failed", detail: sanitizeForLog(String(err)).slice(0, 2000) };
      }
      await writeDoneMarker(req.workspaceDir);
      return { success: true };
    }

    return {
      success: false,
      error: `pi produced no turn response after ${maxAttempts} attempt(s)`,
      detail: sanitizeForLog(diagnostics.join("\n---\n")).slice(0, 4000),
    };
  }

  private async runInitPhases(req: TurnRequest, extensionPath: string): Promise<TurnResult> {
    const maxAttempts = resolveMaxAttempts();
    const diagnostics: string[] = [];
    const conceptsPrompt = await buildInitConceptsUserPrompt(req.workspaceDir, req.playerInput);

    let conceptsApplied = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      req.signal.throwIfAborted();
      const token = beginTurnAttempt(req.storyId);
      const attemptResult = await executePiAttempt({
        req,
        spawnFn: this.spawnFn,
        piPath: this.piPath,
        args: buildPiArgs(extensionPath, PI_INIT_CONCEPTS_SYSTEM_PROMPT,
          diagnostics.length ? `${conceptsPrompt}\n\n上次候选未通过校验，请修复后重新写完整 Bundle：\n${diagnostics.at(-1)}` : conceptsPrompt),
        phase: "init-concepts",
        allowedPaths: INIT_CONCEPT_ALLOWED_ARTIFACTS,
        token,
      });
      const { result, spawnError, watcherFired } = attemptResult;

      if (attemptResult.manifestError) {
        return {
          success: false,
          error: "pi init workspace manifest failed",
          detail: `phase 1 attempt ${attempt}: ${sanitizeForLog(
            attemptResult.manifestError instanceof Error
              ? attemptResult.manifestError.message
              : String(attemptResult.manifestError),
          )}`,
        };
      }
      if (attemptResult.unauthorized) {
        return {
          success: false,
          error: "pi init workspace write boundary violated",
          detail: `phase 1 attempt ${attempt}: ${attemptResult.unauthorized}`,
        };
      }
      if (spawnError !== undefined) {
        return {
          success: false,
          error: "pi runner crashed",
          detail: sanitizeForLog(spawnError instanceof Error ? spawnError.message : String(spawnError)),
        };
      }
      if (!result) return { success: false, error: "pi runner crashed", detail: "spawn returned no result" };
      if (result.aborted || req.signal.aborted) {
        return { success: false, error: "aborted", detail: sanitizeForLog(result.stderr).slice(0, 2000) };
      }
      if (result.code !== 0 && !watcherFired) {
        diagnostics.push(
          `phase 1 attempt ${attempt}: pi exit=${result.code}\n${sanitizeForLog(result.stdout + "\n" + result.stderr).slice(0, 2000)}`,
        );
        continue;
      }
      if (!(await mtimeFresherThan(path.join(req.workspaceDir, "turn/state-update.md"), attemptResult.artifactBaselines.stateUpdate))) {
        diagnostics.push(`phase 1 attempt ${attempt}: init bundle missing or stale`);
        continue;
      }

      const stateUpdatePath = path.join(req.workspaceDir, "turn", "state-update.md");
      let rawBundle: string;
      try {
        rawBundle = await fs.readFile(stateUpdatePath, "utf8");
      } catch {
        diagnostics.push(`phase 1 attempt ${attempt}: init bundle read failed`);
        continue;
      }
      const parsedBundle = parseInitWorkspaceBundle(rawBundle);
      if (!parsedBundle.ok) {
        diagnostics.push(`phase 1 attempt ${attempt}: ${parsedBundle.error}`);
        continue;
      }
      try {
        parsePublicSceneFromPlayer(parsedBundle.files.find(file => file.path === "player.md")?.content ?? "");
      } catch (error) {
        diagnostics.push(`phase 1 attempt ${attempt}: invalid Public Scene: ${String(error)}`);
        continue;
      }
      try {
        await applyInitWorkspaceBundle(req.workspaceDir, parsedBundle.files);
      } catch (err) {
        const detail = sanitizeForLog(err instanceof Error ? err.message : String(err));
        return {
          success: false,
          error: "pi init bundle apply failed",
          detail: `phase 1 attempt ${attempt}: init bundle apply failed: ${detail}`,
        };
      }
      conceptsApplied = true;
      break;
    }

    if (!conceptsApplied) {
      return {
        success: false,
        error: `pi produced no init concepts after ${maxAttempts} attempt(s)`,
        detail: sanitizeForLog(diagnostics.join("\n---\n")).slice(0, 4000),
      };
    }

    req.signal.throwIfAborted();
    const openingPrompt = await buildInitOpeningUserPrompt(req.workspaceDir);
    const openingArgs = buildPiArgs(
      extensionPath,
      PI_INIT_OPENING_SYSTEM_PROMPT,
      openingPrompt,
    );
    const openingDiagnostics: string[] = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      req.signal.throwIfAborted();
      const token = beginTurnAttempt(req.storyId);
      const attemptResult = await executePiAttempt({
        req,
        spawnFn: this.spawnFn,
        piPath: this.piPath,
        args: openingArgs,
        phase: "init-opening",
        allowedPaths: INIT_OPENING_ALLOWED_ARTIFACTS,
        token,
      });
      const { result, spawnError, watcherFired } = attemptResult;

      if (attemptResult.manifestError) {
        return {
          success: false,
          error: "pi init workspace manifest failed",
          detail: `phase 2 attempt ${attempt}: ${sanitizeForLog(
            attemptResult.manifestError instanceof Error
              ? attemptResult.manifestError.message
              : String(attemptResult.manifestError),
          )}`,
        };
      }
      if (attemptResult.unauthorized) {
        return {
          success: false,
          error: "pi init workspace write boundary violated",
          detail: `phase 2 attempt ${attempt}: ${attemptResult.unauthorized}`,
        };
      }
      if (spawnError !== undefined) {
        return {
          success: false,
          error: "pi runner crashed",
          detail: sanitizeForLog(spawnError instanceof Error ? spawnError.message : String(spawnError)),
        };
      }
      if (!result) return { success: false, error: "pi runner crashed", detail: "spawn returned no result" };
      if (result.aborted || req.signal.aborted) {
        return { success: false, error: "aborted", detail: sanitizeForLog(result.stderr).slice(0, 2000) };
      }
      if (result.code !== 0 && !watcherFired) {
        openingDiagnostics.push(
          `phase 2 attempt ${attempt}: pi exit=${result.code}\n${sanitizeForLog(result.stdout + "\n" + result.stderr).slice(0, 2000)}`,
        );
        continue;
      }
      const openingValidation = await validateInitOpeningArtifacts(
        req.workspaceDir,
        attemptResult.artifactBaselines,
      );
      if (!openingValidation.ok) {
        openingDiagnostics.push(
          `phase 2 attempt ${attempt}: ${openingValidation.problem ?? "opening artifacts invalid"}`,
        );
        continue;
      }
      await writeDoneMarker(req.workspaceDir);
      return {
        success: true,
        detail: watcherFired ? "phase 2 early-exit fired (skipped final round-trip)" : undefined,
      };
    }

    return {
      success: false,
      error: `pi produced no init opening after ${maxAttempts} attempt(s)`,
      detail: sanitizeForLog(openingDiagnostics.join("\n---\n")).slice(0, 4000),
    };
  }
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
 * turn 的 output.md 就绪即发布叙事；init Phase 2 等本 attempt 的 output 与
 * interaction 都就绪后再用后者做泄密指纹，Phase 1 不发布预览。交互建议始终先净化再发布。预览只是提前显示，
 * 权威仍是磁盘产物 + orchestrator 校验链。token 为 attempt 令牌——
 * 迟到发布（跨越重试/终局）由 turn-progress 丢弃。
 */
function makePiEventHandler(req: TurnRequest, token: number, phase: PiPhase): (line: string) => void {
  // Concept generation is still untrusted until the complete bundle has been
  // parsed and applied.  Do not let its tool-call stream enter the ordinary
  // turn preview side-channel, even if it mentions candidate opening files.
  if (phase === "init-concepts") return () => {};

  const initPreview: { output?: string; interactionFingerprints?: string[] } | undefined =
    phase === "init-opening" ? {} : undefined;

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
