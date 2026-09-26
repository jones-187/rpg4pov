#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const factLedgerEvaluator = require("./fact-ledger-ab-eval.cjs");

const ARMS = ["static", "maintained"];
const EVALUATION_MODELS = new Set(["deepseek-v4.1-flash", "glm-5.3-flash"]);
const OPENING_TURN_ID = "00000000-0000-4000-8000-000000000002";
const OPENING_AT = "2026-09-26T10:00:00.000Z";
const TECHNICAL_FAILURE_TEXT = "TECHNICAL FAILURE — NO PLAYER OUTPUT";

function parseArgs(raw) {
  return factLedgerEvaluator.parseArgs(raw);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value, field) {
  if (!Array.isArray(value) || value.length === 0
    || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${field} must be a non-empty string array`);
  }
  return value;
}

function validateScenario(scenario) {
  if (!isRecord(scenario)) throw new Error("scenario must be an object");
  requireString(scenario.experiment, "scenario.experiment");
  if (!EVALUATION_MODELS.has(scenario.model)) {
    throw new Error(`scenario.model must be one of: ${[...EVALUATION_MODELS].join(", ")}`);
  }
  if (scenario.piThinking !== "xhigh") {
    throw new Error("scenario.piThinking must be xhigh (Pi max)");
  }
  if (scenario.repeatsPerArm !== 3) throw new Error("scenario.repeatsPerArm must be 3");
  const callsPerTurn = scenario.callsPerTurn ?? 1;
  if (callsPerTurn !== 1 && callsPerTurn !== 2) {
    throw new Error("scenario.callsPerTurn must be 1 or 2");
  }
  if (scenario.automaticRetries !== 0) throw new Error("scenario.automaticRetries must be 0");
  if (!Array.isArray(scenario.arms) || scenario.arms.length !== 2
    || scenario.arms.some((arm, index) => arm !== ARMS[index])) {
    throw new Error("scenario.arms must be [static, maintained]");
  }
  if (!Array.isArray(scenario.order) || scenario.order.length !== scenario.repeatsPerArm) {
    throw new Error("scenario.order must have one pair per repeat");
  }
  let previousFirstArm;
  const firstArms = new Set();
  for (const round of scenario.order) {
    if (!Array.isArray(round) || round.length !== 2 || new Set(round).size !== 2
      || round.some((arm) => !scenario.arms.includes(arm))) {
      throw new Error("scenario.order pair must contain both arms exactly once");
    }
    if (round[0] === previousFirstArm) {
      throw new Error("scenario.order must alternate which arm runs first");
    }
    previousFirstArm = round[0];
    firstArms.add(round[0]);
  }
  if (firstArms.size !== 2) throw new Error("scenario.order must interleave both arms");
  if (!Array.isArray(scenario.cases) || scenario.cases.length !== 3) {
    throw new Error("scenario.cases must contain exactly 3 cases");
  }

  const ids = new Set();
  for (const testCase of scenario.cases) {
    if (!isRecord(testCase)) throw new Error("scenario.cases item must be an object");
    requireString(testCase.id, "case.id");
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(testCase.id) || ids.has(testCase.id)) {
      throw new Error("case.id must be unique lowercase letters, digits, and hyphens");
    }
    ids.add(testCase.id);
    requireString(testCase.dimension, `case ${testCase.id}.dimension`);
    requireString(testCase.title, `case ${testCase.id}.title`);
    requireString(testCase.turn1Input, `case ${testCase.id}.turn1Input`);
    requireString(testCase.turn2Input, `case ${testCase.id}.turn2Input`);
    requireStringArray(testCase.maintenanceChecklist, `case ${testCase.id}.maintenanceChecklist`);
    requireStringArray(testCase.turn2Checklist, `case ${testCase.id}.turn2Checklist`);

    const fixture = testCase.fixture;
    if (!isRecord(fixture)) throw new Error(`case ${testCase.id}.fixture must be an object`);
    for (const key of ["world", "player", "actorFile", "actor", "opening"]) {
      requireString(fixture[key], `case ${testCase.id}.fixture.${key}`);
    }
    if (!/^[^/\\]+\.md$/u.test(fixture.actorFile)) {
      throw new Error(`case ${testCase.id}.fixture.actorFile must be a single Markdown filename`);
    }
    if (!Array.isArray(fixture.priorHistory)) {
      throw new Error(`case ${testCase.id}.fixture.priorHistory must be an array`);
    }
    for (const [index, entry] of fixture.priorHistory.entries()) {
      if (!isRecord(entry)) throw new Error(`case ${testCase.id}.fixture.priorHistory[${index}] must be an object`);
      for (const key of ["turnId", "at", "input", "output"]) {
        requireString(entry[key], `case ${testCase.id}.fixture.priorHistory[${index}].${key}`);
      }
    }
    const ledger = testCase.initialLedger;
    if (!isRecord(ledger) || ledger.version !== "1" || !Array.isArray(ledger.events)
      || (ledger.knowledgeBoundaries !== undefined && !Array.isArray(ledger.knowledgeBoundaries))) {
      throw new Error(`case ${testCase.id}.initialLedger must be a version 1 fact ledger`);
    }
  }
  return scenario;
}

function shouldContinueAfterTurn(record, maximumCalls = 1) {
  return record.modelCallRequests >= 1
    && record.modelCallRequests <= maximumCalls
    && record.modelCalls === record.modelCallRequests;
}

function randomBlindFileId() {
  return `${crypto.randomBytes(8).toString("hex")}.md`;
}

function buildReviewPacket({ testCase, records, randomizer = crypto.randomInt }) {
  if (!Array.isArray(records) || records.length !== 2) {
    throw new Error("review packet requires exactly two arm records");
  }
  const ordered = [...records];
  if (randomizer(0, 2) === 1) ordered.reverse();
  return {
    title: testCase.title,
    turn2Input: testCase.turn2Input,
    turn2Checklist: testCase.turn2Checklist,
    eligibleForSemanticReview: ordered.every((record) =>
      record.turn1TechnicalPass && record.turn2TechnicalPass),
    submissions: ordered.map((record) => ({
      blindFile: `blind/${record.blindTurn2File}`,
      turn1TechnicalPass: record.turn1TechnicalPass,
      turn2TechnicalPass: record.turn2TechnicalPass,
      historyBeforeTurn2: record.historyBeforeTurn2,
    })),
  };
}

async function ensureOutputDirectory(output) {
  let stat;
  try {
    stat = await fs.lstat(output);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (stat) {
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("output path must be a real directory");
    }
    const entries = await fs.readdir(output);
    if (entries.length > 0) throw new Error("output directory must be new and empty");
  } else {
    await fs.mkdir(output, { recursive: true });
  }
  for (const child of ["runs", "blind", "live-workspaces"]) {
    await fs.mkdir(path.join(output, child), { recursive: true });
  }
}

async function writeJsonFile(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n");
  await fs.rename(temp, file);
}

async function writeTextFile(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value);
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function safeUsage(usage) {
  if (!isRecord(usage)) return null;
  const safe = {};
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
  }
  return safe;
}

function safeCallSummary(call) {
  return {
    durationMs: call.durationMs,
    code: call.code,
    aborted: Boolean(call.aborted),
    stopReason: typeof call.stopReason === "string" ? call.stopReason.slice(0, 80) : null,
    hasErrorMessage: Boolean(call.errorMessage),
    usage: safeUsage(call.usage),
    thinkingChars: call.thinkingChars ?? 0,
    textChars: call.textChars ?? 0,
    failure: call.failure ?? null,
  };
}

function hashDiagnostic(detail, sanitizeForLog) {
  const safe = sanitizeForLog(String(detail ?? ""), 4000);
  return {
    present: safe.length > 0,
    characters: safe.length,
    sha256: safe.length > 0
      ? crypto.createHash("sha256").update(safe).digest("hex")
      : null,
  };
}

function parseHistory(raw) {
  if (!raw || !raw.trim()) return [];
  return raw.trim().split("\n").map((line) => JSON.parse(line));
}

async function saveCard(pathname, ledger) {
  await writeJsonFile(pathname, ledger ?? null);
}

function createSpawnFn({ defaultSpawn, tracker, onCallRequest, maxModelCalls = 1 }) {
  return async (cmd, args, opts) => {
    tracker.modelCallRequests += 1;
    await onCallRequest?.();
    if (tracker.modelCallRequests > maxModelCalls) {
      tracker.budgetViolation = true;
      throw new Error(`evaluation budget exceeded: maximum ${maxModelCalls} model call(s) per turn`);
    }
    const argValue = (name) => {
      const position = args.indexOf(name);
      return position >= 0 ? args[position + 1] ?? null : null;
    };
    tracker.piInvocationConfig = {
      thinking: argValue("--thinking"),
      model: argValue("--model"),
      mode: argValue("--mode"),
      provider: argValue("--provider"),
    };
    tracker.modelCalls += 1;
    const started = Date.now();
    let stopReason;
    let errorMessage;
    let usage;
    let thinkingChars = 0;
    let textChars = 0;
    const originalOnStdoutLine = opts.onStdoutLine;
    const wrappedOpts = {
      ...opts,
      onStdoutLine(line) {
        originalOnStdoutLine?.(line);
        try {
          const event = JSON.parse(line);
          const message = event.message;
          if (event.type === "message_end" && message?.role === "assistant") {
            stopReason = message.stopReason;
            errorMessage = message.errorMessage;
            usage = safeUsage(message.usage);
            const blocks = Array.isArray(message.content) ? message.content : [];
            thinkingChars += blocks.filter((block) => block?.type === "thinking")
              .reduce((sum, block) => sum + String(block.thinking || "").length, 0);
            textChars += blocks.filter((block) => block?.type === "text")
              .reduce((sum, block) => sum + String(block.text || "").length, 0);
          }
        } catch {
          // Keep telemetry independent from malformed or partial stream lines.
        }
      },
    };
    try {
      const result = await defaultSpawn(cmd, args, wrappedOpts);
      tracker.calls.push({
        durationMs: Date.now() - started,
        code: result.code,
        aborted: result.aborted,
        stopReason,
        errorMessage,
        usage,
        thinkingChars,
        textChars,
      });
      return result;
    } catch (error) {
      tracker.calls.push({
        durationMs: Date.now() - started,
        code: null,
        aborted: false,
        stopReason,
        errorMessage,
        usage,
        thinkingChars,
        textChars,
        failure: "spawn failed",
      });
      tracker.spawnFailure = true;
      throw error;
    }
  };
}

async function appendFixtureHistory({ appendTurnHistory, storyId, testCase }) {
  for (const entry of testCase.fixture.priorHistory) {
    await appendTurnHistory(storyId, entry);
  }
  await appendTurnHistory(storyId, {
    turnId: OPENING_TURN_ID,
    at: OPENING_AT,
    input: "冻结评估开场",
    output: testCase.fixture.opening,
  });
}

async function runOneTurn({
  runtimeModules,
  storyId,
  testCase,
  arm,
  turnNumber,
  playerInput,
  initialLedger,
  runDir,
  manifest,
  writeManifest,
  maxModelCalls = 1,
}) {
  const { resolveWorkspaceDir, CONTINUITY_CARD_FILE, readContinuityCard } = runtimeModules.workspace;
  const { readTurnHistoryRaw } = runtimeModules.turnHistory;
  const { PiRunner } = runtimeModules.piRunner;
  const { TurnOrchestrator } = runtimeModules.turnOrchestrator;
  const { defaultSpawn } = runtimeModules.agentSpawn;
  const { sanitizeForLog } = runtimeModules.diagnostics;
  const workspace = resolveWorkspaceDir(storyId);
  const canonicalPath = path.join(workspace, CONTINUITY_CARD_FILE);
  const canonicalBefore = arm === "maintained"
    ? await readContinuityCard(storyId)
    : initialLedger;
  if (arm === "maintained" && !canonicalBefore) {
    throw new Error("maintained arm canonical card missing before turn");
  }
  if (arm === "static" && await fileExists(canonicalPath)) {
    throw new Error("static arm unexpectedly has a canonical card before turn");
  }
  const cardStatBefore = arm === "maintained"
    ? await fs.stat(canonicalPath, { bigint: true })
    : null;
  const turnLabel = `turn-${turnNumber}`;
  const cardsDir = path.join(runDir, "cards");
  const historyDir = path.join(runDir, "history");
  await saveCard(path.join(cardsDir, `${turnLabel}-before.json`), canonicalBefore);

  const tracker = {
    modelCallRequests: 0,
    modelCalls: 0,
    budgetViolation: false,
    spawnFailure: false,
    calls: [],
  };
  const spawnFn = createSpawnFn({
    defaultSpawn,
    tracker,
    maxModelCalls,
    onCallRequest: async () => {
      manifest.modelCallRequests += 1;
      await writeManifest();
    },
  });
  const runnerOptions = arm === "maintained"
    ? { spawnFn, publicContinuityCard: true }
    : { spawnFn, experimentalFactLedger: initialLedger };
  const piRunner = new PiRunner(runnerOptions);
  const startedAt = Date.now();
  let outcome;
  let thrown;
  try {
    outcome = await new TurnOrchestrator(piRunner).executeTurn(storyId, playerInput);
  } catch (error) {
    thrown = error;
    outcome = { success: false, error: "orchestrator threw", playerResponse: null, interaction: null };
  }

  const canonicalExistsAfter = await fileExists(canonicalPath);
  let canonicalAfter = null;
  let cardStatAfter = null;
  if (arm === "maintained") {
    if (!canonicalExistsAfter) throw new Error("maintained arm lost its canonical card after turn");
    canonicalAfter = await readContinuityCard(storyId);
    cardStatAfter = await fs.stat(canonicalPath, { bigint: true });
  } else if (canonicalExistsAfter) {
    throw new Error("static arm created an unexpected canonical card");
  }
  await saveCard(path.join(cardsDir, `${turnLabel}-after.json`), canonicalAfter);

  const historyRaw = await readTurnHistoryRaw(storyId);
  const historyPath = path.join(historyDir, `after-${turnLabel}.jsonl`);
  await writeTextFile(historyPath, historyRaw ?? "");
  const callBudgetSatisfied = tracker.modelCallRequests >= 1
    && tracker.modelCallRequests <= maxModelCalls
    && tracker.modelCalls === tracker.modelCallRequests
    && !tracker.budgetViolation
    && !tracker.spawnFailure;
  const technicalPass = Boolean(outcome.success && callBudgetSatisfied);
  const piInvocationConfig = tracker.piInvocationConfig ?? null;
  const cardWriteCommitted = arm === "maintained" && technicalPass && Boolean(cardStatBefore
    && cardStatAfter && cardStatAfter.mtimeNs > cardStatBefore.mtimeNs);
  const record = {
    turnNumber,
    playerInput,
    arm,
    storyId,
    durationMs: Date.now() - startedAt,
    modelCallRequests: tracker.modelCallRequests,
    modelCalls: tracker.modelCalls,
    budgetViolation: tracker.budgetViolation,
    technicalPass,
    technicalStatus: callBudgetSatisfied
      ? (technicalPass ? "pass" : "hard-failure-one-call")
      : "infrastructure-budget-error",
    turnErrorCategory: outcome.success ? null
      : tracker.spawnFailure ? "spawn-failed"
        : thrown ? "orchestrator-threw" : "turn-failed",
    diagnostic: hashDiagnostic(thrown ?? outcome.detail ?? "", sanitizeForLog),
    interaction: outcome.interaction ?? null,
    callSummaries: tracker.calls.map(safeCallSummary),
    piInvocationConfig,
    piModeVerified: piInvocationConfig?.thinking === "xhigh"
      && piInvocationConfig?.model === manifest.model
      && piInvocationConfig?.mode === "json"
      && piInvocationConfig?.provider === "newapi-response",
    canonicalCardExistsBefore: arm === "static" ? false : true,
    canonicalCardExistsAfter: canonicalExistsAfter,
    canonicalCardWriteCommitted: cardWriteCommitted,
    cardBeforeFile: `cards/${turnLabel}-before.json`,
    cardAfterFile: `cards/${turnLabel}-after.json`,
    committedHistoryFile: `history/after-${turnLabel}.jsonl`,
  };
  await writeJsonFile(path.join(runDir, `${turnLabel}.json`), record);
  manifest.completedTurnRuns += 1;
  manifest.technicalPasses += technicalPass ? 1 : 0;
  manifest.modelCalls += tracker.modelCalls;
  await writeManifest();

  return {
    ...record,
    playerResponse: technicalPass && typeof outcome.playerResponse === "string"
      ? outcome.playerResponse : null,
    historyAfter: parseHistory(historyRaw),
    canonicalAfter,
  };
}

async function runChain({
  runtimeModules,
  output,
  testCase,
  arm,
  repeat,
  index,
  initialLedger,
  manifest,
  writeManifest,
  maxModelCalls = 1,
}) {
  const { createStory, resolveWorkspaceDir, writeContinuityCard, CONTINUITY_CARD_FILE } = runtimeModules.workspace;
  const { appendTurnHistory } = runtimeModules.turnHistory;
  const { parseFactLedger } = runtimeModules.factLedger;
  const runName = `${String(index).padStart(2, "0")}-${testCase.id}-${arm}-${repeat}`;
  const runDir = path.join(output, "runs", runName);
  await fs.mkdir(runDir, { recursive: true });

  const story = await createStory({ title: `[连续性维护 A/B] ${testCase.title}` });
  const workspace = resolveWorkspaceDir(story.storyId);
  await fs.writeFile(path.join(workspace, "world.md"), `${testCase.fixture.world}\n`);
  await fs.writeFile(path.join(workspace, "player.md"), `${testCase.fixture.player}\n`);
  await fs.writeFile(path.join(workspace, "rules.md"),
    "# 规则\n\n写实叙事；普通对话不掷随机。只把已经发生且需要持续记住的变化写入状态。\n");
  await fs.writeFile(path.join(workspace, "actors", testCase.fixture.actorFile), `${testCase.fixture.actor}\n`);
  await appendFixtureHistory({ appendTurnHistory, storyId: story.storyId, testCase });
  const parsedInitialLedger = parseFactLedger(initialLedger);
  await saveCard(path.join(runDir, "cards", "initial-ledger.json"), parsedInitialLedger);

  const canonicalPath = path.join(workspace, CONTINUITY_CARD_FILE);
  if (arm === "maintained") {
    await writeContinuityCard(story.storyId, parsedInitialLedger);
  } else if (await fileExists(canonicalPath)) {
    throw new Error("static arm canonical card exists at chain initialization");
  }
  const runtimeCard = arm === "maintained"
    ? await runtimeModules.workspace.readContinuityCard(story.storyId)
    : parsedInitialLedger;
  if (JSON.stringify(runtimeCard) !== JSON.stringify(parsedInitialLedger)) {
    throw new Error("arm initial card does not match the frozen ledger");
  }

  const chainMetadata = {
    caseId: testCase.id,
    repeat,
    arm,
    storyId: story.storyId,
    runnerMode: arm === "maintained" ? "publicContinuityCard:true" : "experimentalFactLedger",
    workspacePath: path.relative(output, workspace),
    initialCardFile: `cards/initial-ledger.json`,
  };
  await writeJsonFile(path.join(runDir, "metadata.json"), chainMetadata);

  const turn1 = await runOneTurn({
    runtimeModules,
    storyId: story.storyId,
    testCase,
    arm,
    turnNumber: 1,
    playerInput: testCase.turn1Input,
    initialLedger: parsedInitialLedger,
    runDir,
    manifest,
    writeManifest,
    maxModelCalls,
  });
  if (!shouldContinueAfterTurn(turn1, maxModelCalls)) {
    const error = new Error("turn 1 violated the bounded evaluation call budget");
    error.code = "call-budget-violation";
    throw error;
  }

  const historyBeforeTurn2 = turn1.historyAfter;
  await writeJsonFile(path.join(runDir, "history", "before-turn-2.json"), historyBeforeTurn2);
  const turn2 = await runOneTurn({
    runtimeModules,
    storyId: story.storyId,
    testCase,
    arm,
    turnNumber: 2,
    playerInput: testCase.turn2Input,
    initialLedger: parsedInitialLedger,
    runDir,
    manifest,
    writeManifest,
    maxModelCalls,
  });
  if (!shouldContinueAfterTurn(turn2, maxModelCalls)) {
    const error = new Error("turn 2 violated the bounded evaluation call budget");
    error.code = "call-budget-violation";
    throw error;
  }

  const blindTurn2File = randomBlindFileId();
  await writeTextFile(
    path.join(output, "blind", blindTurn2File),
    `${turn2.playerResponse ?? TECHNICAL_FAILURE_TEXT}\n`,
  );
  await writeJsonFile(path.join(runDir, "blind-turn-2.json"), {
    blindFile: blindTurn2File,
    technicalPass: turn2.technicalPass,
    historyBeforeTurn2File: "history/before-turn-2.json",
  });

  return {
    index,
    runName,
    caseId: testCase.id,
    dimension: testCase.dimension,
    repeat,
    arm,
    storyId: story.storyId,
    turn1TechnicalPass: turn1.technicalPass,
    turn2TechnicalPass: turn2.technicalPass,
    blindTurn2File,
    historyBeforeTurn2,
    canonicalTurn1UpdateCommitted: turn1.canonicalCardWriteCommitted,
  };
}

async function readScenario(file) {
  const wrapper = JSON.parse(await fs.readFile(file, "utf8"));
  if (!isRecord(wrapper) || wrapper.sourceScenario === undefined) return wrapper;
  if (typeof wrapper.sourceScenario !== "string" || !/^[^/\\]+\.json$/u.test(wrapper.sourceScenario)) {
    throw new Error("scenario.sourceScenario must be a sibling JSON filename");
  }
  if (typeof wrapper.sourceScenarioSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(wrapper.sourceScenarioSha256)) {
    throw new Error("scenario.sourceScenarioSha256 must be a SHA-256 hex digest");
  }
  const sourceFile = path.resolve(path.dirname(file), wrapper.sourceScenario);
  const sourceBytes = await fs.readFile(sourceFile);
  const sourceHash = crypto.createHash("sha256").update(sourceBytes).digest("hex");
  if (sourceHash !== wrapper.sourceScenarioSha256) {
    throw new Error(`source scenario hash mismatch: expected ${wrapper.sourceScenarioSha256}, received ${sourceHash}`);
  }
  const source = JSON.parse(sourceBytes.toString("utf8"));
  return {
    ...source,
    experiment: wrapper.experiment,
    model: wrapper.model,
    piThinking: wrapper.piThinking,
    callsPerTurn: wrapper.callsPerTurn,
    automaticRetries: wrapper.automaticRetries,
    sourceScenario: sourceFile,
    sourceScenarioSha256: sourceHash,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtime = path.resolve(args.runtime);
  const output = path.resolve(args.output);
  const scenarioFile = path.resolve(args.scenario);
  const scenario = validateScenario(await readScenario(scenarioFile));
  const runtimeModules = {
    workspace: require(path.join(runtime, "lib/workspace.js")),
    turnHistory: require(path.join(runtime, "lib/turn-history.js")),
    piRunner: require(path.join(runtime, "lib/pi-runner.js")),
    turnOrchestrator: require(path.join(runtime, "lib/turn-orchestrator.js")),
    factLedger: require(path.join(runtime, "lib/fact-ledger.js")),
    agentSpawn: require(path.join(runtime, "lib/agent-spawn.js")),
    diagnostics: require(path.join(runtime, "lib/diagnostics.js")),
    agentModel: require(path.join(runtime, "lib/agent-model.js")),
  };
  const runtimeModel = runtimeModules.agentModel.resolveAgentModel();
  if (runtimeModel !== scenario.model) {
    throw new Error(`scenario model ${scenario.model} does not match runtime model ${runtimeModel}`);
  }
  for (const testCase of scenario.cases) {
    runtimeModules.factLedger.parseFactLedger(testCase.initialLedger);
  }
  await ensureOutputDirectory(output);
  process.env.WORKSPACE_ROOT = path.join(output, "live-workspaces");
  const callsPerTurn = scenario.callsPerTurn ?? 1;
  process.env.PI_MAX_ATTEMPTS = String(callsPerTurn);

  const startedAt = new Date().toISOString();
  const manifest = {
    createdAt: startedAt,
    scenario: scenarioFile,
    runtime,
    model: runtimeModel,
    piThinking: scenario.piThinking,
    maxAttempts: callsPerTurn,
    callsPerTurn,
    automaticRetries: 0,
    repeatsPerArm: scenario.repeatsPerArm,
    caseCount: scenario.cases.length,
    chainCount: scenario.cases.length * scenario.repeatsPerArm * scenario.arms.length,
    maximumPlannedCalls: scenario.cases.length * scenario.repeatsPerArm * scenario.arms.length * 2 * callsPerTurn,
    modelCallRequests: 0,
    modelCalls: 0,
    completedTurnRuns: 0,
    technicalPasses: 0,
    order: scenario.order,
    status: "running",
  };
  const writeManifest = () => writeJsonFile(path.join(output, "manifest.json"), manifest);
  await writeManifest();
  await writeJsonFile(path.join(output, "metadata.json"), {
    experiment: scenario.experiment,
    createdAt: startedAt,
    scenario: scenarioFile,
    runtime,
    model: runtimeModel,
    piThinking: "xhigh",
    productThinkingLabel: "max",
    maxAttempts: callsPerTurn,
    callsPerTurn,
    automaticRetries: 0,
    armModes: {
      static: "experimentalFactLedger receives the unchanged initial card on both turns",
      maintained: "publicContinuityCard reads and commits workspace continuity-card.json",
    },
    chainIsolation: "one fresh workspace per case x repeat x arm",
  });

  const mapping = [];
  const pairRecords = new Map();
  let chainIndex = 0;
  try {
    for (let repeat = 1; repeat <= scenario.repeatsPerArm; repeat += 1) {
      for (const testCase of scenario.cases) {
        const pairKey = `${testCase.id}:${repeat}`;
        for (const arm of scenario.order[repeat - 1]) {
          chainIndex += 1;
          const initialLedger = runtimeModules.factLedger.parseFactLedger(testCase.initialLedger);
          const result = await runChain({
            runtimeModules,
            output,
            testCase,
            arm,
            repeat,
            index: chainIndex,
            initialLedger,
            manifest,
            writeManifest,
            maxModelCalls: callsPerTurn,
          });
          const pair = pairRecords.get(pairKey) ?? [];
          pair.push(result);
          pairRecords.set(pairKey, pair);
          mapping.push({
            blindFile: result.blindTurn2File,
            arm: result.arm,
            caseId: result.caseId,
            repeat: result.repeat,
            runDir: `runs/${result.runName}`,
            turn1TechnicalPass: result.turn1TechnicalPass,
            turn2TechnicalPass: result.turn2TechnicalPass,
          });
          await writeJsonFile(path.join(output, "mapping.json"), mapping);
          await fs.appendFile(path.join(output, "summary.jsonl"), `${JSON.stringify({
            caseId: result.caseId,
            repeat: result.repeat,
            arm: result.arm,
            turn1TechnicalPass: result.turn1TechnicalPass,
            turn2TechnicalPass: result.turn2TechnicalPass,
            canonicalTurn1UpdateCommitted: result.canonicalTurn1UpdateCommitted,
            blindFile: result.blindTurn2File,
          })}\n`);
          if (pair.length === 2) {
            const packet = buildReviewPacket({ testCase, records: pair });
            await writeJsonFile(
              path.join(output, "blind", `review-${testCase.id}-${repeat}.json`),
              packet,
            );
            pairRecords.delete(pairKey);
          }
          await writeManifest();
        }
      }
    }
    manifest.status = "completed";
    manifest.completedAt = new Date().toISOString();
    await writeManifest();
  } catch (error) {
    manifest.status = "stopped";
    manifest.stopCode = error?.code === "call-budget-violation"
      ? "call-budget-violation" : "infrastructure-error";
    manifest.stoppedAt = new Date().toISOString();
    await writeManifest();
    throw new Error(manifest.stopCode);
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "evaluation failed"}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  validateScenario,
  shouldContinueAfterTurn,
  buildReviewPacket,
  ensureOutputDirectory,
  appendFixtureHistory,
  runOneTurn,
  readScenario,
};
