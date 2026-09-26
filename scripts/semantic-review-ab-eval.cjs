#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const continuityEval = require("./continuity-maintenance-ab-eval.cjs");

const ARMS = ["baseline", "reviewed"];
const REVIEW_SYSTEM_PROMPT = `你是互动叙事的独立事实审查员，不负责润色，也不续写故事。
只审查候选是否存在硬语义错误：
1. 把权威材料没有提供的期限、规则、地点、待遇、经历或因果写成确定事实；
2. 混淆玩家、NPC、system/model 或文件明文的来源；
3. 让角色知道其知情范围之外的秘密；
4. 替玩家作尚未作出的重大决定，或新增会关闭选择的默认后果；
5. 污染故事时间，或与已发生事件直接矛盾。
合理的新台词、动作、感官细节和不确定推测不是错误。不要评价文风。
只输出 JSON：通过时 {"verdict":"pass","issues":[]}；拒绝时 {"verdict":"reject","issues":["具体问题及其冲突证据"]}。最多列 8 项。`;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSemanticReview(raw) {
  let value;
  try {
    value = JSON.parse(String(raw).trim());
  } catch {
    throw new Error("semantic review is not valid JSON");
  }
  if (!isRecord(value) || !["pass", "reject"].includes(value.verdict)
    || !Array.isArray(value.issues) || Object.keys(value).sort().join(",") !== "issues,verdict") {
    throw new Error("semantic review must contain exactly verdict and issues");
  }
  if (value.issues.length > 8
    || value.issues.some((issue) => typeof issue !== "string" || issue.trim() === "" || issue.length > 1000)) {
    throw new Error("semantic review issues are invalid");
  }
  if ((value.verdict === "pass" && value.issues.length !== 0)
    || (value.verdict === "reject" && value.issues.length === 0)) {
    throw new Error("semantic review verdict and issues disagree");
  }
  return value.verdict === "pass"
    ? { pass: true }
    : { pass: false, issues: [...value.issues] };
}

function buildReviewPrompt(request) {
  return [
    "<authoritative_context>",
    request.authoritativeContext,
    "</authoritative_context>",
    "<candidate_response>",
    request.candidateResponse,
    "</candidate_response>",
    "请按系统规则审查候选。只输出规定的 JSON。",
  ].join("\n");
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

function parseArgs(raw) {
  const reviewerModelAt = raw.indexOf("--reviewer-model");
  const reviewerModel = reviewerModelAt >= 0 ? raw[reviewerModelAt + 1] : "kimi-k3";
  if (reviewerModel !== "kimi-k3") throw new Error("reviewer model must be kimi-k3");
  const baseArgs = reviewerModelAt >= 0
    ? raw.filter((_, index) => index !== reviewerModelAt && index !== reviewerModelAt + 1)
    : raw;
  const parsed = continuityEval.parseArgs(baseArgs);
  return { ...parsed, reviewerModel };
}

function createReviewerModelsJson({ baseUrl, apiKey, reviewerModel }) {
  const normalized = baseUrl.replace(/\/+$/u, "");
  return JSON.stringify({
    providers: {
      "newapi-review": {
        baseUrl: normalized.endsWith("/v1") ? normalized : `${normalized}/v1`,
        api: "openai-completions",
        apiKey,
        models: [{
          id: reviewerModel,
          reasoning: true,
          compat: { supportsDeveloperRole: false },
        }],
      },
    },
  }, null, 2);
}

async function createSemanticReviewer({ runtimeModules, output, reviewerModel, piPath = "pi" }) {
  const baseUrl = process.env.ANTHROPIC_BASE_URL?.trim();
  const apiKey = process.env.ANTHROPIC_AUTH_TOKEN?.trim() || process.env.ANTHROPIC_API_KEY?.trim();
  if (!baseUrl || !apiKey) throw new Error("reviewer requires configured model gateway credentials");
  const reviewerHome = path.join(output, ".reviewer-home");
  const configFile = path.join(reviewerHome, ".pi", "agent", "models.json");
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  await fs.writeFile(configFile, `${createReviewerModelsJson({ baseUrl, apiKey, reviewerModel })}\n`, { mode: 0o600 });
  const responseExtension = path.resolve(process.env.PI_RESPONSE_EXTENSION_PATH?.trim() || "pi-extensions/json-response.ts");
  await fs.access(responseExtension);
  let reviewIndex = 0;
  const records = [];

  const review = async (request) => {
    reviewIndex += 1;
    const callDir = path.join(output, "reviews", String(reviewIndex).padStart(3, "0"));
    await fs.mkdir(callDir, { recursive: true });
    const basePrompt = buildReviewPrompt(request);
    await writeText(path.join(callDir, "input.txt"), `${basePrompt}\n`);
    let repairContext = "";
    const attempts = [];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      request.signal.throwIfAborted();
      const collector = runtimeModules.piResponse.createPiResponseCollector();
      const args = [
        "-p", "--no-session", "--no-tools", "--no-extensions", "--no-context-files",
        "--extension", responseExtension, "--no-skills", "--no-prompt-templates",
        "--mode", "json", "--provider", "newapi-review", "--thinking", "xhigh",
        "--model", reviewerModel, "--system-prompt", REVIEW_SYSTEM_PROMPT,
        [basePrompt, repairContext].filter(Boolean).join("\n\n"),
      ];
      const started = Date.now();
      const result = await runtimeModules.agentSpawn.defaultSpawn(piPath, args, {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH,
          HOME: reviewerHome,
          NODE_ENV: process.env.NODE_ENV,
          TMPDIR: process.env.TMPDIR,
        },
        signal: request.signal,
        stdinData: "",
        stdio: ["pipe", "pipe", "pipe"],
        onStdoutLine: collector.onLine,
      });
      let raw = "";
      let parsed;
      let error = null;
      try {
        if (result.code !== 0 || result.aborted) throw new Error(`reviewer exit=${result.code}`);
        raw = collector.finish(result.stdout);
        parsed = parseSemanticReview(raw);
      } catch (caught) {
        error = String(caught);
      }
      attempts.push({
        attempt,
        durationMs: Date.now() - started,
        exitCode: result.code,
        aborted: Boolean(result.aborted),
        raw,
        error,
      });
      await writeJson(path.join(callDir, `attempt-${attempt}.json`), attempts.at(-1));
      if (parsed) {
        const record = { reviewIndex, result: parsed, attempts: attempts.length };
        records.push(record);
        await writeJson(path.join(callDir, "result.json"), record);
        return parsed;
      }
      repairContext = [
        "上一次审查响应未通过结构校验。不要重新审查，只把同一判定改成规定的 JSON。",
        `错误：${error}`,
        "上一次响应：",
        raw || "（没有可解析的完整响应）",
      ].join("\n");
    }
    throw new Error("semantic reviewer produced no valid response after 2 attempts");
  };
  return { review, records, reviewerHome };
}

async function loadSourceScenario(file) {
  const scenario = continuityEval.validateScenario(JSON.parse(await fs.readFile(file, "utf8")));
  return scenario;
}

async function initializeRun({ runtimeModules, output, testCase, arm, repeat, index }) {
  const runName = `${String(index).padStart(2, "0")}-${testCase.id}-${arm}-${repeat}`;
  const runDir = path.join(output, "runs", runName);
  await fs.mkdir(runDir, { recursive: true });
  const story = await runtimeModules.workspace.createStory({ title: `[语义审查 A/B] ${testCase.title}` });
  const workspace = runtimeModules.workspace.resolveWorkspaceDir(story.storyId);
  await fs.writeFile(path.join(workspace, "world.md"), `${testCase.fixture.world}\n`);
  await fs.writeFile(path.join(workspace, "player.md"), `${testCase.fixture.player}\n`);
  await fs.writeFile(path.join(workspace, "rules.md"), "# 规则\n\n写实叙事；普通对话不掷随机。只把已经发生且需要持续记住的变化写入状态。\n");
  await fs.writeFile(path.join(workspace, "actors", testCase.fixture.actorFile), `${testCase.fixture.actor}\n`);
  await continuityEval.appendFixtureHistory({
    appendTurnHistory: runtimeModules.turnHistory.appendTurnHistory,
    storyId: story.storyId,
    testCase,
  });
  const initialLedger = runtimeModules.factLedger.parseFactLedger(testCase.initialLedger);
  await runtimeModules.workspace.writeContinuityCard(story.storyId, initialLedger);
  return { runName, runDir, storyId: story.storyId, initialLedger };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtime = path.resolve(args.runtime);
  const output = path.resolve(args.output);
  const scenarioFile = path.resolve(args.scenario);
  const scenario = await loadSourceScenario(scenarioFile);
  if (scenario.model !== "deepseek-v4.1-flash") throw new Error("generator must be deepseek-v4.1-flash");
  const runtimeModules = {
    workspace: require(path.join(runtime, "lib/workspace.js")),
    turnHistory: require(path.join(runtime, "lib/turn-history.js")),
    piRunner: require(path.join(runtime, "lib/pi-runner.js")),
    turnOrchestrator: require(path.join(runtime, "lib/turn-orchestrator.js")),
    factLedger: require(path.join(runtime, "lib/fact-ledger.js")),
    agentSpawn: require(path.join(runtime, "lib/agent-spawn.js")),
    diagnostics: require(path.join(runtime, "lib/diagnostics.js")),
    agentModel: require(path.join(runtime, "lib/agent-model.js")),
    piResponse: require(path.join(runtime, "lib/pi-response.js")),
  };
  if (runtimeModules.agentModel.resolveAgentModel() !== scenario.model) {
    throw new Error("runtime generator model mismatch");
  }
  await continuityEval.ensureOutputDirectory(output);
  process.env.WORKSPACE_ROOT = path.join(output, "live-workspaces");
  process.env.PI_MAX_ATTEMPTS = "2";
  const reviewer = await createSemanticReviewer({ runtimeModules, output, reviewerModel: args.reviewerModel });
  const manifest = {
    createdAt: new Date().toISOString(),
    status: "running",
    generatorModel: scenario.model,
    reviewerModel: args.reviewerModel,
    cases: scenario.cases.length,
    repeatsPerArm: 3,
    arms: ARMS,
    plannedTurns: scenario.cases.length * 3 * ARMS.length,
    completedTurns: 0,
    technicalPasses: 0,
  };
  const writeManifest = () => writeJson(path.join(output, "manifest.json"), manifest);
  await writeManifest();
  await writeJson(path.join(output, "metadata.json"), {
    experiment: "heterogeneous-semantic-review-ab",
    scenario: scenarioFile,
    generatorModel: scenario.model,
    reviewerModel: args.reviewerModel,
    reviewerFormatAttempts: 2,
    generatorFormatAttempts: 2,
    semanticRepairAttempts: 1,
    productionEnabled: false,
  });
  let index = 0;
  try {
    for (let repeat = 1; repeat <= 3; repeat += 1) {
      for (const testCase of scenario.cases) {
        const order = repeat % 2 === 1 ? ARMS : [...ARMS].reverse();
        for (const arm of order) {
          index += 1;
          const run = await initializeRun({ runtimeModules, output, testCase, arm, repeat, index });
          const reviewStart = reviewer.records.length;
          const turn = await continuityEval.runOneTurn({
            runtimeModules,
            storyId: run.storyId,
            testCase,
            arm: "maintained",
            turnNumber: 1,
            playerInput: testCase.turn1Input,
            initialLedger: run.initialLedger,
            runDir: run.runDir,
            manifest: {
              model: scenario.model,
              modelCallRequests: 0,
              modelCalls: 0,
              completedTurnRuns: 0,
              technicalPasses: 0,
            },
            writeManifest: async () => {},
            maxModelCalls: arm === "reviewed" ? 3 : 2,
            semanticReviewer: arm === "reviewed" ? reviewer.review : undefined,
          });
          const reviewRecords = reviewer.records.slice(reviewStart);
          const result = {
            index,
            caseId: testCase.id,
            repeat,
            arm,
            technicalPass: turn.technicalPass,
            generatorCalls: turn.modelCalls,
            semanticReviews: reviewRecords,
            responseFile: turn.playerResponse ? "response.md" : null,
            cardFile: "cards/turn-1-after.json",
          };
          if (turn.playerResponse) await writeText(path.join(run.runDir, "response.md"), `${turn.playerResponse}\n`);
          await writeJson(path.join(run.runDir, "result.json"), result);
          await fs.appendFile(path.join(output, "summary.jsonl"), `${JSON.stringify(result)}\n`);
          manifest.completedTurns += 1;
          manifest.technicalPasses += turn.technicalPass ? 1 : 0;
          await writeManifest();
        }
      }
    }
    manifest.status = "completed";
    manifest.completedAt = new Date().toISOString();
    await writeManifest();
  } catch (error) {
    manifest.status = "stopped";
    manifest.stoppedAt = new Date().toISOString();
    manifest.error = String(error);
    await writeManifest();
    throw error;
  } finally {
    await fs.rm(reviewer.reviewerHome, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "semantic review A/B failed"}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseSemanticReview,
  buildReviewPrompt,
  createReviewerModelsJson,
  createSemanticReviewer,
};
