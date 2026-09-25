#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");

function parseArgs(raw) {
  const out = {};
  for (let i = 0; i < raw.length; i += 2) {
    const key = raw[i], value = raw[i + 1];
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

const args = parseArgs(process.argv.slice(2));
const { defaultSpawn } = require(path.join(args.runtime, "lib/agent-spawn.js"));
const { PiRunner } = require(path.join(args.runtime, "lib/pi-runner.js"));
const { TurnOrchestrator } = require(path.join(args.runtime, "lib/turn-orchestrator.js"));
const { createStory, resolveWorkspaceDir } = require(path.join(args.runtime, "lib/workspace.js"));
const { appendTurnHistory } = require(path.join(args.runtime, "lib/turn-history.js"));

const secrets = Object.entries(process.env)
  .filter(([key, value]) => value && /TOKEN|KEY|SECRET|PASSWORD|AUTH/i.test(key))
  .map(([, value]) => value);
function safe(value) {
  let text = JSON.stringify(value, null, 2);
  for (const secret of secrets) text = text.split(secret).join("<REDACTED>");
  return text;
}

async function writeFixture(testCase) {
  const story = await createStory({ title: `[评估] ${testCase.title}` });
  const workspace = resolveWorkspaceDir(story.storyId);
  await Promise.all([
    fs.writeFile(path.join(workspace, "world.md"), testCase.world + "\n"),
    fs.writeFile(path.join(workspace, "player.md"), testCase.player + "\n"),
    fs.writeFile(path.join(workspace, "rules.md"), "# 规则\n\n写实叙事；普通对话不掷随机。只把已经发生且需要持续记住的变化写入状态。\n"),
    fs.writeFile(path.join(workspace, "actors", testCase.actorFile), testCase.actor + "\n"),
  ]);
  await appendTurnHistory(story.storyId, {
    turnId: "00000000-0000-4000-8000-000000000001",
    at: "2026-09-25T10:00:00.000Z",
    input: "冻结评估开场",
    output: testCase.opening,
  });
  return { storyId: story.storyId, workspace };
}

async function runOne(testCase, arm, repeat, index) {
  const runDir = path.join(args.output, "runs", `${String(index).padStart(2, "0")}-${testCase.id}-${arm}-${repeat}`);
  await fs.mkdir(runDir, { recursive: true });
  const { storyId, workspace } = await writeFixture(testCase);
  const calls = [];
  const spawnFn = async (cmd, spawnArgs, opts) => {
    const events = [];
    const next = opts.onStdoutLine;
    opts.onStdoutLine = line => {
      next?.(line);
      try {
        const event = JSON.parse(line), message = event.message;
        if (event.type === "message_end" && message?.role === "assistant") {
          const blocks = Array.isArray(message.content) ? message.content : [];
          events.push({
            stopReason: message.stopReason,
            errorMessage: message.errorMessage,
            usage: message.usage,
            thinkingChars: blocks.filter(block => block?.type === "thinking")
              .reduce((sum, block) => sum + String(block.thinking || "").length, 0),
            content: blocks.filter(block => block?.type !== "thinking"),
          });
        }
      } catch {}
    };
    const started = Date.now();
    const result = await defaultSpawn(cmd, spawnArgs, opts);
    calls.push({ durationMs: Date.now() - started, code: result.code, aborted: result.aborted,
      stderr: result.stderr.slice(0, 2000), events });
    return result;
  };
  const started = Date.now();
  const outcome = await new TurnOrchestrator(new PiRunner({
    spawnFn,
    experimentalSceneSeparation: arm === "separated",
  })).executeTurn(storyId, testCase.playerInput);
  const durationMs = Date.now() - started;
  const output = outcome.playerResponse || "";
  const advisoryHits = testCase.advisoryTokens.filter(token => output.includes(token));
  await fs.writeFile(path.join(runDir, "calls.json"), safe(calls) + "\n");
  await fs.cp(workspace, path.join(runDir, "workspace"), { recursive: true });
  const record = { index, caseId: testCase.id, dimension: testCase.dimension, arm, repeat,
    storyId, durationMs, modelCalls: calls.length, technicalPass: outcome.success,
    error: outcome.error || null, interaction: outcome.interaction || null, advisoryHits };
  await fs.writeFile(path.join(runDir, "result.json"), safe(record) + "\n");
  await fs.appendFile(path.join(args.output, "summary.jsonl"), JSON.stringify(record) + "\n");
  process.stdout.write(JSON.stringify(record) + "\n");
}

async function main() {
  const scenario = JSON.parse(await fs.readFile(args.scenario, "utf8"));
  try {
    if ((await fs.readdir(args.output)).length) throw new Error("output directory is not empty");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await fs.mkdir(args.output, { recursive: true });
  }
  process.env.WORKSPACE_ROOT = path.join(args.output, "live-workspaces");
  process.env.PI_MAX_ATTEMPTS = "1";
  await fs.writeFile(path.join(args.output, "manifest.json"), safe({
    createdAt: new Date().toISOString(), scenario: args.scenario, runtime: args.runtime,
    model: scenario.model, retries: 0, gate: scenario.promotionGate,
  }) + "\n");
  let index = 0;
  for (let repeat = 1; repeat <= scenario.repeatsPerArm; repeat++) {
    for (const testCase of scenario.cases) {
      for (const arm of scenario.order[repeat - 1]) {
        await runOne(testCase, arm, repeat, ++index);
      }
    }
  }
}

main().catch(error => {
  process.stderr.write(safe({ error: String(error) }) + "\n");
  process.exitCode = 1;
});
