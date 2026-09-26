#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const continuityEval = require("./continuity-maintenance-ab-eval.cjs");

const REQUIRED_MODEL = "kimi-k3";
const EXPECTED_SOURCE_HASH = /^[a-f0-9]{64}$/u;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function validateScreeningScenario(scenario) {
  if (!isRecord(scenario)) throw new Error("screening scenario must be an object");
  requireString(scenario.experiment, "scenario.experiment");
  if (scenario.model !== REQUIRED_MODEL) {
    throw new Error(`scenario.model must be ${REQUIRED_MODEL}`);
  }
  if (scenario.piThinking !== "xhigh") throw new Error("scenario.piThinking must be xhigh (Pi max)");
  if (scenario.repeatsPerCase !== 3) throw new Error("scenario.repeatsPerCase must be 3");
  if (scenario.arm !== "maintained") throw new Error("scenario.arm must be maintained");
  if (scenario.callsPerTurn !== 1 && scenario.callsPerTurn !== 2) {
    throw new Error("scenario.callsPerTurn must be 1 or 2");
  }
  if (scenario.automaticRetries !== 0) throw new Error("scenario.automaticRetries must be 0");
  if (typeof scenario.sourceScenario !== "string"
    || !/^[^/\\]+\.json$/u.test(scenario.sourceScenario)) {
    throw new Error("scenario.sourceScenario must be a sibling JSON filename");
  }
  if (typeof scenario.sourceScenarioSha256 !== "string"
    || !EXPECTED_SOURCE_HASH.test(scenario.sourceScenarioSha256)) {
    throw new Error("scenario.sourceScenarioSha256 must be a SHA-256 hex digest");
  }
  if (!isRecord(scenario.promotionGate)
    || scenario.promotionGate.technicalPasses !== 9
    || scenario.promotionGate.hardSemanticErrors !== 0
    || scenario.promotionGate.nextStage !== "complete-36-call-ab") {
    throw new Error("scenario.promotionGate must require 9 technical passes and zero hard semantic errors");
  }
  return scenario;
}

function assertRuntimeModel(scenarioModel, runtimeModel) {
  if (typeof runtimeModel !== "string" || scenarioModel !== runtimeModel) {
    throw new Error(`screening scenario model ${scenarioModel} does not match runtime model ${runtimeModel}`);
  }
}

function buildScreeningPlan(screeningScenario, sourceScenario) {
  const validated = validateScreeningScenario(screeningScenario);
  if (!Array.isArray(sourceScenario.cases) || sourceScenario.cases.length !== 3) {
    throw new Error("source scenario must contain exactly 3 frozen cases");
  }
  const plan = [];
  for (let repeat = 1; repeat <= validated.repeatsPerCase; repeat += 1) {
    for (const testCase of sourceScenario.cases) {
      plan.push({ index: plan.length + 1, repeat, testCase, arm: validated.arm });
    }
  }
  return plan;
}

function isExactSingleCall(record) {
  return record.modelCallRequests === 1
    && record.modelCalls === 1
    && record.budgetViolation !== true
    && record.turnErrorCategory !== "spawn-failed"
    && Array.isArray(record.callSummaries)
    && record.callSummaries.length === 1
    && record.callSummaries[0].failure !== "spawn failed";
}

function isWithinCallBudget(record, maximumCalls) {
  return Number.isInteger(maximumCalls)
    && maximumCalls >= 1
    && record.modelCallRequests >= 1
    && record.modelCallRequests <= maximumCalls
    && record.modelCalls === record.modelCallRequests
    && record.budgetViolation !== true
    && record.turnErrorCategory !== "spawn-failed"
    && Array.isArray(record.callSummaries)
    && record.callSummaries.length === record.modelCalls
    && record.callSummaries.every((call) => call.failure !== "spawn failed");
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temp, file);
}

async function writeText(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value);
}

function loadRuntimeModules(runtime) {
  return {
    workspace: require(path.join(runtime, "lib/workspace.js")),
    turnHistory: require(path.join(runtime, "lib/turn-history.js")),
    piRunner: require(path.join(runtime, "lib/pi-runner.js")),
    turnOrchestrator: require(path.join(runtime, "lib/turn-orchestrator.js")),
    factLedger: require(path.join(runtime, "lib/fact-ledger.js")),
    agentSpawn: require(path.join(runtime, "lib/agent-spawn.js")),
    diagnostics: require(path.join(runtime, "lib/diagnostics.js")),
    agentModel: require(path.join(runtime, "lib/agent-model.js")),
  };
}

async function runScreeningCase({ runtimeModules, output, planEntry, manifest, writeManifest }) {
  const { testCase, repeat, index, arm } = planEntry;
  const { createStory, resolveWorkspaceDir, writeContinuityCard } = runtimeModules.workspace;
  const { appendTurnHistory } = runtimeModules.turnHistory;
  const { parseFactLedger } = runtimeModules.factLedger;
  const runName = `${String(index).padStart(2, "0")}-${testCase.id}-${arm}-${repeat}`;
  const runDir = path.join(output, "runs", runName);
  await fs.mkdir(runDir, { recursive: true });

  const story = await createStory({ title: `[连续性维护筛查] ${testCase.title}` });
  const workspace = resolveWorkspaceDir(story.storyId);
  await fs.writeFile(path.join(workspace, "world.md"), `${testCase.fixture.world}\n`);
  await fs.writeFile(path.join(workspace, "player.md"), `${testCase.fixture.player}\n`);
  await fs.writeFile(path.join(workspace, "rules.md"),
    "# 规则\n\n写实叙事；普通对话不掷随机。只把已经发生且需要持续记住的变化写入状态。\n");
  await fs.writeFile(path.join(workspace, "actors", testCase.fixture.actorFile), `${testCase.fixture.actor}\n`);
  await continuityEval.appendFixtureHistory({ appendTurnHistory, storyId: story.storyId, testCase });

  const initialLedger = parseFactLedger(testCase.initialLedger);
  await writeJson(path.join(runDir, "cards", "initial-ledger.json"), initialLedger);
  await writeContinuityCard(story.storyId, initialLedger);
  const runtimeInitialCard = await runtimeModules.workspace.readContinuityCard(story.storyId);
  if (JSON.stringify(runtimeInitialCard) !== JSON.stringify(initialLedger)) {
    throw new Error(`run ${index} initial canonical card does not match frozen card`);
  }

  await writeJson(path.join(runDir, "metadata.json"), {
    caseId: testCase.id,
    repeat,
    arm,
    storyId: story.storyId,
    runnerMode: "publicContinuityCard:true",
    workspacePath: path.relative(output, workspace),
    initialCardFile: "cards/initial-ledger.json",
    sourceScenario: manifest.sourceScenario,
  });

  const turn = await continuityEval.runOneTurn({
    runtimeModules,
    storyId: story.storyId,
    testCase,
    arm,
    turnNumber: 1,
    playerInput: testCase.turn1Input,
    initialLedger,
    runDir,
    manifest,
    writeManifest,
    maxModelCalls: manifest.callsPerTurn,
  });
  if (turn.playerResponse !== null) {
    await writeText(path.join(runDir, "turn-1-response.md"), `${turn.playerResponse}\n`);
  }

  const exactSingleCall = isExactSingleCall(turn);
  const withinCallBudget = isWithinCallBudget(turn, manifest.callsPerTurn);
  const result = {
    index,
    caseId: testCase.id,
    repeat,
    arm,
    storyId: story.storyId,
    technicalPass: turn.technicalPass,
    exactSingleCall,
    withinCallBudget,
    modelCallRequests: turn.modelCallRequests,
    modelCalls: turn.modelCalls,
    canonicalCardWriteCommitted: turn.canonicalCardWriteCommitted,
    cardBeforeFile: "cards/turn-1-before.json",
    cardAfterFile: "cards/turn-1-after.json",
    turnRecordFile: "turn-1.json",
    responseFile: turn.playerResponse === null ? null : "turn-1-response.md",
  };
  await writeJson(path.join(runDir, "screening-result.json"), result);
  await fs.appendFile(path.join(output, "summary.jsonl"), `${JSON.stringify(result)}\n`);
  return result;
}

async function main() {
  const args = continuityEval.parseArgs(process.argv.slice(2));
  const runtime = path.resolve(args.runtime);
  const output = path.resolve(args.output);
  const scenarioFile = path.resolve(args.scenario);
  const scenario = validateScreeningScenario(await readJson(scenarioFile));
  const sourceScenarioFile = path.resolve(path.dirname(scenarioFile), scenario.sourceScenario);
  const sourceBytes = await fs.readFile(sourceScenarioFile);
  const sourceHash = crypto.createHash("sha256").update(sourceBytes).digest("hex");
  if (sourceHash !== scenario.sourceScenarioSha256) {
    throw new Error(`source scenario hash mismatch: expected ${scenario.sourceScenarioSha256}, received ${sourceHash}`);
  }
  const sourceScenario = continuityEval.validateScenario(JSON.parse(sourceBytes.toString("utf8")));
  const plan = buildScreeningPlan(scenario, sourceScenario);
  const runtimeModules = loadRuntimeModules(runtime);
  const runtimeModel = runtimeModules.agentModel.resolveAgentModel();
  assertRuntimeModel(scenario.model, runtimeModel);
  for (const testCase of sourceScenario.cases) {
    runtimeModules.factLedger.parseFactLedger(testCase.initialLedger);
  }

  await continuityEval.ensureOutputDirectory(output);
  process.env.WORKSPACE_ROOT = path.join(output, "live-workspaces");
  process.env.PI_MAX_ATTEMPTS = String(scenario.callsPerTurn);

  const startedAt = new Date().toISOString();
  const manifest = {
    createdAt: startedAt,
    scenario: scenarioFile,
    sourceScenario: sourceScenarioFile,
    sourceScenarioSha256: sourceHash,
    runtime,
    model: runtimeModel,
    piThinking: scenario.piThinking,
    arm: scenario.arm,
    maxAttempts: scenario.callsPerTurn,
    callsPerTurn: scenario.callsPerTurn,
    automaticRetries: 0,
    repeatsPerCase: scenario.repeatsPerCase,
    caseCount: sourceScenario.cases.length,
    plannedRuns: plan.length,
    maximumPlannedCalls: plan.length * scenario.callsPerTurn,
    modelCallRequests: 0,
    modelCalls: 0,
    completedTurnRuns: 0,
    technicalPasses: 0,
    status: "running",
  };
  const writeManifest = () => writeJson(path.join(output, "manifest.json"), manifest);
  await writeManifest();
  await writeJson(path.join(output, "metadata.json"), {
    experiment: scenario.experiment,
    createdAt: startedAt,
    scenario: scenarioFile,
    sourceScenario: sourceScenarioFile,
    sourceScenarioSha256: sourceHash,
    runtime,
    model: runtimeModel,
    piThinking: scenario.piThinking,
    arm: scenario.arm,
    callsPerTurn: scenario.callsPerTurn,
    maxAttempts: scenario.callsPerTurn,
    automaticRetries: 0,
    promotionGate: scenario.promotionGate,
  });

  try {
    for (const planEntry of plan) {
      const result = await runScreeningCase({
        runtimeModules,
        output,
        planEntry,
        manifest,
        writeManifest,
      });
      if (!result.withinCallBudget) {
        const error = new Error(`run ${result.index} exceeded or missed its model call budget`);
        error.code = "call-budget-violation";
        throw error;
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
    process.stderr.write(`${error instanceof Error ? error.message : "screening failed"}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  validateScreeningScenario,
  assertRuntimeModel,
  buildScreeningPlan,
  isExactSingleCall,
  isWithinCallBudget,
};
