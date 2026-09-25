#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

function parseArgs(raw) {
  const out = {};
  for (let i = 0; i < raw.length; i += 2) {
    const key = raw[i];
    const value = raw[i + 1];
    if (!value) throw new Error(`missing value for ${key}`);
    if (key === "--scenario") out.scenario = path.resolve(value);
    else if (key === "--output") out.output = path.resolve(value);
    else if (key === "--runtime") out.runtime = path.resolve(value);
    else throw new Error(`unknown argument: ${key}`);
  }
  if (!out.scenario || !out.output || !out.runtime) {
    throw new Error("required: --scenario <json> --output <new-dir> --runtime <compiled-root>");
  }
  return out;
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
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${field} must be a non-empty string array`);
  }
  return value;
}

function validateScenario(scenario) {
  if (!isRecord(scenario)) throw new Error("scenario must be an object");
  requireString(scenario.experiment, "scenario.experiment");
  requireString(scenario.model, "scenario.model");
  if (scenario.model !== "deepseek-v4.1-flash") {
    throw new Error("scenario.model must be deepseek-v4.1-flash");
  }
  if (scenario.repeatsPerArm !== 3) throw new Error("scenario.repeatsPerArm must be 3");
  if (scenario.automaticRetries !== 0) throw new Error("scenario.automaticRetries must be 0");
  requireStringArray(scenario.arms, "scenario.arms");
  if (scenario.arms.length !== 2 || !scenario.arms.includes("baseline") || !scenario.arms.includes("ledger")) {
    throw new Error("scenario.arms must be [baseline, ledger]");
  }
  if (!Array.isArray(scenario.order) || scenario.order.length !== scenario.repeatsPerArm) {
    throw new Error("scenario.order must have one entry per repeat");
  }
  for (const round of scenario.order) {
    requireStringArray(round, "scenario.order round");
    if (
      round.length !== 2 ||
      new Set(round).size !== 2 ||
      round.some(arm => !scenario.arms.includes(arm))
    ) {
      throw new Error("scenario.order round must contain both arms exactly once");
    }
  }
  if (!Array.isArray(scenario.cases) || scenario.cases.length !== 3) {
    throw new Error("scenario.cases must contain exactly 3 cases");
  }
  const caseIds = new Set();
  for (const testCase of scenario.cases) {
    if (!isRecord(testCase)) throw new Error("scenario.cases item must be an object");
    requireString(testCase.id, "case.id");
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(testCase.id) || caseIds.has(testCase.id)) {
      throw new Error("case.id must be unique lowercase letters, digits, and hyphens");
    }
    caseIds.add(testCase.id);
    requireString(testCase.dimension, "case.dimension");
    requireString(testCase.title, "case.title");
    requireString(testCase.playerInput, "case.playerInput");
    requireStringArray(testCase.blindChecklist, "case.blindChecklist");
    requireStringArray(testCase.advisoryTokens, "case.advisoryTokens");
    if (!isRecord(testCase.fixture)) throw new Error("case.fixture must be an object");
    for (const key of ["world", "player", "actorFile", "actor", "opening"]) {
      requireString(testCase.fixture[key], `case.fixture.${key}`);
    }
    if (!/^[^/\\]+\.md$/u.test(testCase.fixture.actorFile)) {
      throw new Error("case.fixture.actorFile must be a single Markdown filename");
    }
    if (!Array.isArray(testCase.fixture.priorHistory)) {
      throw new Error("case.fixture.priorHistory must be an array");
    }
    for (const [historyIndex, entry] of testCase.fixture.priorHistory.entries()) {
      if (!isRecord(entry)) throw new Error(`case.fixture.priorHistory[${historyIndex}] must be an object`);
      for (const key of ["turnId", "at", "input", "output"]) {
        requireString(entry[key], `case.fixture.priorHistory[${historyIndex}].${key}`);
      }
    }
    if (!isRecord(testCase.ledger)) throw new Error("case.ledger must be an object");
    if (testCase.ledger.version !== "1") {
      throw new Error("case.ledger.version must be 1");
    }
  }
  return scenario;
}

function shouldContinueAfterRun(record) {
  return record.modelCalls === 1;
}

function buildReviewPacket({ testCase, records, randomizer = crypto.randomInt }) {
  const ordered = [...records];
  if (randomizer(0, 2) === 1) ordered.reverse();
  const opening = {
    turnId: "00000000-0000-4000-8000-000000000002",
    at: "2026-09-25T10:01:00.000Z",
    input: "冻结评估开场",
    output: testCase.fixture.opening,
  };
  return {
    title: testCase.title,
    playerInput: testCase.playerInput,
    history: [...testCase.fixture.priorHistory, opening],
    blindChecklist: testCase.blindChecklist,
    blindFiles: ordered.map(record => `blind/${record.blindFile}`),
    eligibleForSemanticReview: records.every(record => record.technicalPass),
  };
}

async function readScenario(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function ensureOutputDirectory(output) {
  try {
    const entries = await fs.readdir(output);
    if (entries.length > 0) throw new Error("output directory must be empty");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await fs.mkdir(output, { recursive: true });
  }
  await fs.mkdir(path.join(output, "runs"), { recursive: true });
  await fs.mkdir(path.join(output, "blind"), { recursive: true });
}

async function writeJsonFile(file, value) {
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n");
  await fs.rename(temp, file);
}

function safeCallSummary(call) {
  return {
    durationMs: call.durationMs,
    code: call.code,
    aborted: Boolean(call.aborted),
    stopReason: call.stopReason ?? null,
    hasErrorMessage: Boolean(call.errorMessage),
    usage: call.usage ?? null,
    thinkingChars: call.thinkingChars ?? 0,
    textChars: call.textChars ?? 0,
    failure: call.failure ?? null,
  };
}

function blindFileId() {
  return crypto.randomBytes(8).toString("hex");
}

async function runOne({ runtime, scenario, testCase, arm, repeat, index, output }) {
  const { createStory, resolveWorkspaceDir } = require(path.join(runtime, "lib/workspace.js"));
  const { appendTurnHistory } = require(path.join(runtime, "lib/turn-history.js"));
  const { PiRunner } = require(path.join(runtime, "lib/pi-runner.js"));
  const { TurnOrchestrator } = require(path.join(runtime, "lib/turn-orchestrator.js"));
  const { parseFactLedger } = require(path.join(runtime, "lib/fact-ledger.js"));
  const { defaultSpawn } = require(path.join(runtime, "lib/agent-spawn.js"));

  const ledger = arm === "ledger" ? parseFactLedger(testCase.ledger) : undefined;
  const runDir = path.join(output, "runs", `${String(index).padStart(2, "0")}-${testCase.id}-${arm}-${repeat}`);
  await fs.mkdir(runDir, { recursive: true });

  const story = await createStory({ title: `[评估] ${testCase.title}` });
  const workspace = resolveWorkspaceDir(story.storyId);
  await fs.writeFile(path.join(workspace, "world.md"), testCase.fixture.world + "\n");
  await fs.writeFile(path.join(workspace, "player.md"), testCase.fixture.player + "\n");
  await fs.writeFile(path.join(workspace, "rules.md"), "# 规则\n\n写实叙事；普通对话不掷随机。只把已经发生且需要持续记住的变化写入状态。\n");
  await fs.writeFile(path.join(workspace, "actors", testCase.fixture.actorFile), testCase.fixture.actor + "\n");
  for (const entry of testCase.fixture.priorHistory) {
    await appendTurnHistory(story.storyId, entry);
  }
  await appendTurnHistory(story.storyId, {
    turnId: "00000000-0000-4000-8000-000000000002",
    at: "2026-09-25T10:01:00.000Z",
    input: "冻结评估开场",
    output: testCase.fixture.opening,
  });

  const calls = [];
  let modelCallCount = 0;
  let spawnFailure;
  const spawnFn = async (cmd, spawnArgs, opts) => {
    if (modelCallCount >= 1) {
      throw new Error("evaluation budget reached: only one model call is allowed per run");
    }
    modelCallCount += 1;
    const started = Date.now();
    let stopReason;
    let errorMessage;
    let usage;
    let thinkingChars = 0;
    let textChars = 0;
    const onStdoutLine = opts.onStdoutLine;
    opts.onStdoutLine = line => {
      onStdoutLine?.(line);
      try {
        const event = JSON.parse(line);
        const message = event.message;
        if (event.type === "message_end" && message?.role === "assistant") {
          stopReason = message.stopReason;
          errorMessage = message.errorMessage;
          usage = message.usage;
          const blocks = Array.isArray(message.content) ? message.content : [];
          thinkingChars += blocks
            .filter(block => block?.type === "thinking")
            .reduce((sum, block) => sum + String(block.thinking || "").length, 0);
          textChars += blocks
            .filter(block => block?.type === "text")
            .reduce((sum, block) => sum + String(block.text || "").length, 0);
        }
      } catch {}
    };
    let result;
    try {
      result = await defaultSpawn(cmd, spawnArgs, opts);
    } catch (error) {
      spawnFailure = { message: error instanceof Error ? error.message : String(error) };
      calls.push({
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
      throw error;
    }
    calls.push({ durationMs: Date.now() - started, code: result.code, aborted: result.aborted,
      stopReason, errorMessage, usage, thinkingChars, textChars });
    return result;
  };

  const started = Date.now();
  let outcome;
  try {
    const runner = new PiRunner({ spawnFn, experimentalFactLedger: ledger });
    outcome = await new TurnOrchestrator(runner).executeTurn(story.storyId, testCase.playerInput);
  } catch (error) {
    outcome = { success: false, error: "runner threw", playerResponse: null, interaction: null };
    if (calls.length === 0) {
      calls.push({ failure: spawnFailure ? "spawn failed" : "runner threw before model call" });
    }
  }
  const durationMs = Date.now() - started;
  const playerResponse = outcome.playerResponse || "";
  const technicalPass = outcome.success && modelCallCount === 1;
  const advisoryHits = technicalPass
    ? testCase.advisoryTokens.filter(token => playerResponse.includes(token))
    : [];
  const safePlayerResponse = technicalPass ? playerResponse : "TECHNICAL FAILURE — NO PLAYER OUTPUT";

  const blindFile = `${blindFileId()}.md`;
  const blindPath = path.join(output, "blind", blindFile);
  await fs.writeFile(blindPath, safePlayerResponse + "\n");

  const record = {
    index,
    caseId: testCase.id,
    dimension: testCase.dimension,
    arm,
    repeat,
    storyId: story.storyId,
    durationMs,
    modelCalls: modelCallCount,
    technicalPass,
    error: outcome.error || null,
    interaction: outcome.interaction || null,
    advisoryHits,
    blindFile,
  };

  await fs.writeFile(path.join(runDir, "calls.json"), JSON.stringify(calls.map(safeCallSummary), null, 2) + "\n");
  await fs.cp(workspace, path.join(runDir, "workspace"), { recursive: true });
  await fs.writeFile(path.join(runDir, "result.json"), JSON.stringify(record, null, 2) + "\n");
  return record;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtime = path.resolve(args.runtime);
  const output = path.resolve(args.output);
  const scenarioFile = path.resolve(args.scenario);
  await ensureOutputDirectory(output);
  const scenario = validateScenario(await readScenario(scenarioFile));
  const { parseFactLedger } = require(path.join(runtime, "lib/fact-ledger.js"));
  const { resolveAgentModel } = require(path.join(runtime, "lib/agent-model.js"));
  const runtimeModel = resolveAgentModel();
  if (scenario.model !== runtimeModel) {
    throw new Error(`scenario model ${scenario.model} does not match runtime model ${runtimeModel}`);
  }
  for (const testCase of scenario.cases) parseFactLedger(testCase.ledger);

  process.env.WORKSPACE_ROOT = path.join(output, "live-workspaces");
  process.env.PI_MAX_ATTEMPTS = "1";
  await fs.mkdir(path.join(output, "live-workspaces"), { recursive: true });
  const manifest = {
    createdAt: new Date().toISOString(),
    scenario: scenarioFile,
    runtime,
    model: runtimeModel,
    retries: 0,
    repeatsPerArm: scenario.repeatsPerArm,
    caseCount: scenario.cases.length,
    plannedCalls: scenario.cases.length * scenario.repeatsPerArm * scenario.arms.length,
    attemptedCalls: 0,
    completedRuns: 0,
    technicalPasses: 0,
    order: scenario.order,
    status: "running",
  };
  await writeJsonFile(path.join(output, "manifest.json"), manifest);

  const mapping = [];
  const pairs = new Map();
  let index = 0;
  for (let repeat = 1; repeat <= scenario.repeatsPerArm; repeat++) {
    for (const testCase of scenario.cases) {
      for (const arm of scenario.order[repeat - 1]) {
        index += 1;
        manifest.attemptedCalls = index;
        await writeJsonFile(path.join(output, "manifest.json"), manifest);
        const record = await runOne({ runtime, scenario, testCase, arm, repeat, index, output });
        manifest.completedRuns += 1;
        manifest.technicalPasses += record.technicalPass ? 1 : 0;
        mapping.push({ blindFile: record.blindFile, arm: record.arm, caseId: record.caseId, repeat: record.repeat, runDir: `runs/${String(index).padStart(2, "0")}-${testCase.id}-${arm}-${repeat}` });
        await fs.appendFile(path.join(output, "summary.jsonl"), JSON.stringify(record) + "\n");
        await writeJsonFile(path.join(output, "mapping.json"), mapping);
        await writeJsonFile(path.join(output, "manifest.json"), manifest);

        const pairKey = `${testCase.id}:${repeat}`;
        const pair = pairs.get(pairKey) ?? [];
        pair.push(record);
        if (pair.length === 2) {
          await writeJsonFile(
            path.join(output, "blind", `review-${testCase.id}-${repeat}.json`),
            buildReviewPacket({ testCase, records: pair }),
          );
          pairs.delete(pairKey);
        } else {
          pairs.set(pairKey, pair);
        }

        if (!shouldContinueAfterRun(record)) {
          throw new Error(`run ${index} made ${record.modelCalls} model calls; expected exactly 1`);
        }
      }
    }
  }

  manifest.status = "completed";
  await writeJsonFile(path.join(output, "manifest.json"), manifest);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, validateScenario, shouldContinueAfterRun, buildReviewPacket };
