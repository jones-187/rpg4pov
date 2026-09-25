#!/usr/bin/env node
/**
 * Run one long-form story evaluation in a fresh workspace and save reviewable
 * per-round snapshots. This command intentionally does not discover or reuse
 * stories from any existing workspace root.
 *
 * Example:
 *   node dist/cli/story-eval.js \
 *     --workspace-root /tmp/rpg4pov-eval-workspace \
 *     --report-dir /tmp/rpg4pov-eval-report \
 *     --scenario docs/acceptance/scenarios/continuity.json
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { ClaudeCodeRunner } from "../lib/claude-code-runner";
import type { AgentRunner, TurnRequest, TurnResult } from "../lib/agent-runner";
import { PiRunner } from "../lib/pi-runner";
import { TurnOrchestrator } from "../lib/turn-orchestrator";
import { createStory, resolveWorkspaceDir } from "../lib/workspace";

interface EvalScenario {
  setting: string;
  title: string;
  inputs: string[];
}

interface CliOptions {
  workspaceRoot: string;
  reportDir: string;
  scenarioPath: string;
  limit?: number;
  separated: boolean;
  initRunner: "pi" | "claude";
}

interface RoundRecord {
  status: "success" | "failed";
  durationMs: number;
  storyId: string;
  round: number;
  task: "init" | "turn";
  runner: "pi" | "claude";
  separated: boolean;
  snapshotDir: string;
  reason: string | null;
  detail: string | null;
}

interface SnapshotManifest {
  capturedAt: string;
  files: Record<string, "copied" | "missing" | "unsafe">;
}

const USAGE = `用法：
  story-eval --workspace-root <新空目录> --report-dir <独立报告目录> --scenario <场景 JSON> [--limit <回合数>]

必需参数：
  --workspace-root  新故事专用的空 workspace root；已存在且非空时拒绝执行
  --report-dir      独立报告目录；已存在且非空时拒绝执行
  --scenario        JSON 场景文件，包含 setting、title、inputs:string[]
可选参数：
  --limit           只运行前 N 条玩家输入（0 表示只执行 init）
  --separated       turn 使用实验性的 scene-plan 分离路径
  --init-runner     init 使用 pi（默认）或显式指定 claude 基线；turn 始终使用 pi
`;

const SNAPSHOT_FILES = [
  ["world.md", "world.md"],
  ["player.md", "player.md"],
  [path.join("turn", "output.md"), "output.md"],
  [path.join("turn", "interaction.json"), "interaction.json"],
  [path.join("turn", "state-update.md"), "state-update.md"],
  [path.join("turn", "roll-request.json"), "roll-request.json"],
  [path.join("turn", "scene-plan.json"), "scene-plan.json"],
  [path.join("turns", "history.jsonl"), "history.jsonl"],
  [path.join("logs", "random-rolls.jsonl"), "random-rolls.jsonl"],
] as const;

/** Keep init runner selection explicit; turn always stays on the Pi runner. */
class InitRunnerDispatch implements AgentRunner {
  constructor(
    private readonly turnRunner: AgentRunner,
    private readonly initRunner: AgentRunner,
  ) {}

  runTurn(req: TurnRequest): Promise<TurnResult> {
    return (req.task === "init" ? this.initRunner : this.turnRunner).runTurn(req);
  }
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }

  const options = parseArgs(rawArgs);
  const scenario = await readScenario(options.scenarioPath);
  await ensureFreshDirectory(options.workspaceRoot, "workspace root");
  await ensureFreshReportDirectory(options.reportDir, options.workspaceRoot);

  // workspace.ts resolves the root for every operation. Set it only after
  // validating that this command will not touch an existing story tree.
  process.env.WORKSPACE_ROOT = options.workspaceRoot;

  const story = await createStory({ title: scenario.title });
  const workspaceDir = resolveWorkspaceDir(story.storyId);
  const reportStoryDir = path.join(options.reportDir, story.storyId);
  await fs.mkdir(reportStoryDir, { recursive: true });
  const resultsPath = path.join(options.reportDir, "results.jsonl");
  const piRunner = new PiRunner({ experimentalSceneSeparation: options.separated });
  const runner: AgentRunner =
    options.initRunner === "claude"
      ? new InitRunnerDispatch(piRunner, new ClaudeCodeRunner())
      : piRunner;
  const orchestrator = new TurnOrchestrator(runner);

  const initRecord = await runRound({
    orchestrator,
    storyId: story.storyId,
    workspaceDir,
    reportStoryDir,
    playerInput: scenario.setting,
    round: 0,
    task: "init",
    runner: options.initRunner,
    separated: options.separated,
  });
  await emitRecord(initRecord.record, resultsPath);
  if (!initRecord.success) {
    process.exitCode = 1;
    return;
  }

  const inputLimit = Math.min(options.limit ?? scenario.inputs.length, scenario.inputs.length);
  for (let index = 0; index < inputLimit; index++) {
    const record = await runRound({
      orchestrator,
      storyId: story.storyId,
      workspaceDir,
      reportStoryDir,
      playerInput: scenario.inputs[index] ?? "",
      round: index + 1,
      task: "turn",
      runner: "pi",
      separated: options.separated,
    });
    await emitRecord(record.record, resultsPath);
    if (!record.success) {
      process.exitCode = 1;
      return;
    }
  }
}

async function runRound(args: {
  orchestrator: TurnOrchestrator;
  storyId: string;
  workspaceDir: string;
  reportStoryDir: string;
  playerInput: string;
  round: number;
  task: "init" | "turn";
  runner: "pi" | "claude";
  separated: boolean;
}): Promise<{ success: boolean; record: RoundRecord }> {
  const startedAt = Date.now();
  let outcome;
  try {
    outcome = await args.orchestrator.executeTurn(
      args.storyId,
      args.playerInput,
      args.task === "init" ? { task: "init" } : undefined,
    );
  } catch (error) {
    outcome = {
      success: false,
      playerResponse: null,
      error: `orchestrator crashed: ${errorMessage(error)}`,
    };
  }

  const snapshotName = `round-${String(args.round).padStart(3, "0")}-${args.task}`;
  const snapshotPath = path.join(args.reportStoryDir, snapshotName);
  await saveRoundSnapshot(args.workspaceDir, snapshotPath);
  const detail = await readLatestFailureDetail(args.workspaceDir, args.storyId);
  const record: RoundRecord = {
    status: outcome.success ? "success" : "failed",
    durationMs: Date.now() - startedAt,
    storyId: args.storyId,
    round: args.round,
    task: args.task,
    runner: args.runner,
    separated: args.separated,
    snapshotDir: path.relative(path.dirname(args.reportStoryDir), snapshotPath),
    reason: outcome.success ? null : sanitizeDiagnostic(outcome.error ?? "round failed"),
    detail: outcome.success ? null : sanitizeDiagnostic(detail),
  };
  return { success: outcome.success, record };
}

async function emitRecord(record: RoundRecord, resultsPath: string): Promise<void> {
  const line = JSON.stringify(record);
  process.stdout.write(line + "\n");
  await fs.appendFile(resultsPath, line + "\n", "utf8");
}

function parseArgs(args: string[]): CliOptions {
  const values = new Map<string, string>();
  const known = new Set([
    "--workspace-root",
    "--report-dir",
    "--scenario",
    "--limit",
    "--separated",
    "--init-runner",
  ]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    const equals = arg.indexOf("=");
    const key = equals >= 0 ? arg.slice(0, equals) : arg;
    if (!known.has(key)) throw new Error(`未知参数: ${arg}\n\n${USAGE}`);
    if (key === "--separated") {
      if (equals >= 0) throw new Error("--separated 不接受值");
      if (values.has(key)) throw new Error(`参数重复: ${key}`);
      values.set(key, "true");
      continue;
    }
    const value = equals >= 0 ? arg.slice(equals + 1) : args[++index];
    if (!value || value.startsWith("--")) throw new Error(`参数缺少值: ${key}`);
    if (values.has(key)) throw new Error(`参数重复: ${key}`);
    values.set(key, value);
  }

  const workspaceRoot = resolveRequiredPath(values, "--workspace-root");
  const reportDir = resolveRequiredPath(values, "--report-dir");
  const scenarioPath = resolveRequiredPath(values, "--scenario");
  let limit: number | undefined;
  const rawLimit = values.get("--limit");
  if (rawLimit !== undefined) {
    if (!/^\d+$/u.test(rawLimit)) throw new Error("--limit 必须是非负整数");
    limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit)) throw new Error("--limit 超出安全整数范围");
  }
  const initRunner = values.get("--init-runner") ?? "pi";
  if (initRunner !== "pi" && initRunner !== "claude") {
    throw new Error("--init-runner 只能是 pi 或 claude");
  }
  return {
    workspaceRoot,
    reportDir,
    scenarioPath,
    limit,
    separated: values.has("--separated"),
    initRunner,
  };
}

function resolveRequiredPath(values: Map<string, string>, key: string): string {
  const value = values.get(key)?.trim();
  if (!value) throw new Error(`缺少必需参数: ${key}\n\n${USAGE}`);
  return path.resolve(value);
}

async function readScenario(file: string): Promise<EvalScenario> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`无法读取 scenario JSON: ${errorMessage(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("scenario 必须是 JSON 对象");
  }
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.title !== "string" || candidate.title.trim() === "") {
    throw new Error("scenario.title 必须是非空字符串");
  }
  if (typeof candidate.setting !== "string" || candidate.setting.trim() === "") {
    throw new Error("scenario.setting 必须是非空字符串");
  }
  if (
    !Array.isArray(candidate.inputs) ||
    candidate.inputs.some((input) => typeof input !== "string" || input.trim() === "")
  ) {
    throw new Error("scenario.inputs 必须是非空字符串数组");
  }
  return {
    title: candidate.title,
    setting: candidate.setting,
    inputs: candidate.inputs as string[],
  };
}

async function ensureFreshDirectory(dir: string, label: string): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`${label} 无法访问: ${errorMessage(error)}`);
    }
    await fs.mkdir(dir, { recursive: true });
    return;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} 必须是普通目录: ${dir}`);
  }
  const entries = await fs.readdir(dir);
  if (entries.length > 0) throw new Error(`${label} 必须为空，拒绝复用: ${dir}`);
}

async function ensureFreshReportDirectory(reportDir: string, workspaceRoot: string): Promise<void> {
  const relative = path.relative(workspaceRoot, reportDir);
  if (relative === "" || (!relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))) {
    throw new Error("--report-dir 必须与 --workspace-root 独立，不能位于 workspace root 内");
  }
  await ensureFreshDirectory(reportDir, "report directory");
}

async function saveRoundSnapshot(workspaceDir: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  const files: SnapshotManifest["files"] = {};
  for (const [sourceRelative, destinationRelative] of SNAPSHOT_FILES) {
    const source = path.join(workspaceDir, sourceRelative);
    const target = path.join(destination, destinationRelative);
    const result = await copySnapshotFile(source, target);
    files[destinationRelative] = result;
  }

  const actorsDir = path.join(workspaceDir, "actors");
  try {
    const actorNames = (await fs.readdir(actorsDir)).filter((name) => /^[^/\\]+\.md$/u.test(name));
    for (const name of actorNames) {
      const destinationRelative = path.join("actors", name);
      files[destinationRelative] = await copySnapshotFile(
        path.join(actorsDir, name),
        path.join(destination, destinationRelative),
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    files.actors = "missing";
  }
  const manifest: SnapshotManifest = { capturedAt: new Date().toISOString(), files };
  await fs.writeFile(path.join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

async function copySnapshotFile(
  source: string,
  target: string,
): Promise<"copied" | "missing" | "unsafe"> {
  try {
    const stat = await fs.lstat(source);
    if (stat.isSymbolicLink() || !stat.isFile()) return "unsafe";
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
    return "copied";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function readLatestFailureDetail(workspaceDir: string, storyId: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(workspaceDir, "logs", "turn-errors.log"), "utf8");
  } catch {
    return null;
  }
  for (const line of raw.trim().split(/\r?\n/).reverse()) {
    try {
      const entry = JSON.parse(line) as { storyId?: unknown; detail?: unknown };
      if (entry.storyId === storyId && typeof entry.detail === "string") return entry.detail;
    } catch {
      // Ignore a malformed diagnostic line; the round reason remains authoritative.
    }
  }
  return null;
}

function sanitizeDiagnostic(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let text = String(value).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  const sensitiveEnvValues = Object.entries(process.env)
    .filter(
      ([key, envValue]) =>
        envValue &&
        /(?:provider|token|api[_-]?key|auth(?:orization)?|bearer|secret|password)/iu.test(key),
    )
    .map(([, envValue]) => envValue as string)
    .sort((a, b) => b.length - a.length);
  for (const envValue of sensitiveEnvValues) {
    text = text.split(envValue).join("[REDACTED]");
  }
  // Do not expose provider names, credentials, or token-shaped diagnostics in
  // the machine-readable report. Keep the rest useful and bounded.
  text = text.replace(
    /\b(?:provider|token|api[_-]?key|auth(?:orization)?|bearer|secret|password)\b[^\r\n]*/giu,
    "[REDACTED]",
  );
  return text.length > 4000 ? text.slice(0, 4000) + "\n...[truncated]" : text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  process.stderr.write(`story-eval failed: ${sanitizeDiagnostic(errorMessage(error)) ?? "[REDACTED]"}\n`);
  process.exitCode = 1;
});
