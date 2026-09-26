#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`missing ${name}`);
  return path.resolve(process.argv[i + 1]);
}

async function exists(file) {
  try { await fs.access(file); return true; } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function snapshot(workspace, destination) {
  await fs.rm(destination, { recursive: true, force: true });
  await fs.cp(workspace, destination, { recursive: true });
}

async function main() {
  const scenarioFile = arg("--scenario");
  const output = arg("--output");
  const runtime = arg("--runtime");
  if (await exists(output)) throw new Error("output must not already exist");
  await fs.mkdir(path.join(output, "live-workspaces"), { recursive: true });

  const scenario = JSON.parse(await fs.readFile(scenarioFile, "utf8"));
  const sourceFile = path.resolve(path.dirname(scenarioFile), scenario.sourceScenario);
  const source = JSON.parse(await fs.readFile(sourceFile, "utf8"));
  if (scenario.model !== "deepseek-v4.1-flash" || scenario.repeats !== 3
    || scenario.maxAttemptsPerGeneration !== 2 || scenario.cases.length !== 3) {
    throw new Error("scenario protocol mismatch");
  }
  const sourceCases = new Map(source.cases.map((item) => [item.id, item]));

  const workspaceLib = require(path.join(runtime, "lib/workspace.js"));
  const historyLib = require(path.join(runtime, "lib/turn-history.js"));
  const { PiRunner } = require(path.join(runtime, "lib/pi-runner.js"));
  const { TurnOrchestrator } = require(path.join(runtime, "lib/turn-orchestrator.js"));
  const { resolveAgentModel } = require(path.join(runtime, "lib/agent-model.js"));
  if (resolveAgentModel() !== scenario.model) throw new Error("runtime model mismatch");

  process.env.WORKSPACE_ROOT = path.join(output, "live-workspaces");
  process.env.PI_MAX_ATTEMPTS = String(scenario.maxAttemptsPerGeneration);
  const records = [];
  let index = 0;
  for (let repeat = 1; repeat <= scenario.repeats; repeat++) {
    for (const spec of scenario.cases) {
      index++;
      const testCase = sourceCases.get(spec.sourceCase);
      if (!testCase) throw new Error(`source case missing: ${spec.sourceCase}`);
      const runName = `${String(index).padStart(2, "0")}-${spec.dimension}-${repeat}`;
      const runDir = path.join(output, "runs", runName);
      await fs.mkdir(runDir, { recursive: true });
      const story = await workspaceLib.createStory({ title: `[重写验收] ${testCase.title}` });
      const workspace = workspaceLib.resolveWorkspaceDir(story.storyId);
      await fs.writeFile(path.join(workspace, "world.md"), testCase.fixture.world);
      await fs.writeFile(path.join(workspace, "player.md"), testCase.fixture.player);
      await fs.writeFile(path.join(workspace, "rules.md"), "# 规则\n\n写实叙事；普通对话不掷随机；未知事实不得补全为结论。\n");
      await fs.writeFile(path.join(workspace, "actors", testCase.fixture.actorFile), testCase.fixture.actor);
      for (const entry of testCase.fixture.priorHistory) {
        await historyLib.appendTurnHistory(story.storyId, entry);
      }
      await historyLib.appendTurnHistory(story.storyId, {
        turnId: "00000000-0000-4000-8000-000000000002",
        at: "2026-09-26T10:00:00.000Z",
        input: "冻结评估开场",
        output: testCase.fixture.opening,
      });

      const orchestrator = new TurnOrchestrator(new PiRunner());
      const initialStarted = Date.now();
      const initial = await orchestrator.executeTurn(story.storyId, testCase.playerInput);
      const initialDurationMs = Date.now() - initialStarted;
      const initialHistory = await historyLib.readTurnHistory(story.storyId);
      await snapshot(workspace, path.join(runDir, "initial-workspace"));
      console.log(`${runName} initial ${initial.success ? "PASS" : "FAIL"} ${initialDurationMs}ms`);

      const retryStarted = Date.now();
      const retry = initial.success
        ? await orchestrator.retryLatestTurn(story.storyId, spec.correction)
        : { success: false, playerResponse: null, error: "initial turn failed" };
      const retryDurationMs = Date.now() - retryStarted;
      const retryHistory = await historyLib.readTurnHistory(story.storyId);
      await snapshot(workspace, path.join(runDir, "retry-workspace"));
      console.log(`${runName} retry ${retry.success ? "PASS" : "FAIL"} ${retryDurationMs}ms`);

      const initialTurn = initialHistory?.at(-1) ?? null;
      const retryTurn = retryHistory?.at(-1) ?? null;
      const invariants = {
        sameInput: Boolean(initialTurn && retryTurn && initialTurn.input === retryTurn.input),
        sameTurnId: Boolean(initialTurn && retryTurn && initialTurn.turnId === retryTurn.turnId),
        historyLengthUnchanged: initialHistory?.length === retryHistory?.length,
        earlierHistoryUnchanged: JSON.stringify(initialHistory?.slice(0, -1)) === JSON.stringify(retryHistory?.slice(0, -1)),
      };
      const record = {
        runName,
        repeat,
        caseId: spec.sourceCase,
        dimension: spec.dimension,
        storyId: story.storyId,
        playerInput: testCase.playerInput,
        correction: spec.correction,
        checks: spec.checks,
        initial: { success: initial.success, error: initial.error ?? null, durationMs: initialDurationMs, turn: initialTurn },
        retry: { success: retry.success, error: retry.error ?? null, durationMs: retryDurationMs, turn: retryTurn },
        invariants,
      };
      await writeJson(path.join(runDir, "result.json"), record);
      records.push(record);
    }
  }
  const summary = {
    experiment: scenario.experiment,
    model: scenario.model,
    completedAt: new Date().toISOString(),
    groups: records.length,
    initialTechnicalPasses: records.filter((r) => r.initial.success).length,
    retryTechnicalPasses: records.filter((r) => r.retry.success).length,
    invariantPasses: records.filter((r) => Object.values(r.invariants).every(Boolean)).length,
    promotionGate: scenario.promotionGate,
    records,
  };
  await writeJson(path.join(output, "summary.json"), summary);
  console.log(JSON.stringify({ groups: summary.groups, initialTechnicalPasses: summary.initialTechnicalPasses,
    retryTechnicalPasses: summary.retryTechnicalPasses, invariantPasses: summary.invariantPasses }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
