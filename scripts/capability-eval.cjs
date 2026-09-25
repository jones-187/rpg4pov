#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { isDeepStrictEqual } = require("node:util");

const args = parseArgs(process.argv.slice(2));
let stopping = false;
process.on("SIGINT", () => { stopping = true; });

function parseArgs(raw) {
  const out = { repeats: 3, timeoutMs: 300000, limitCalls: 36 };
  for (let i = 0; i < raw.length; i += 2) {
    const key = raw[i], value = raw[i + 1];
    if (!value) throw new Error(`missing value for ${key}`);
    if (key === "--scenario") out.scenario = path.resolve(value);
    else if (key === "--output") out.output = path.resolve(value);
    else if (key === "--extension") out.extension = path.resolve(value);
    else if (key === "--timeout-ms") out.timeoutMs = Number(value);
    else if (key === "--limit-calls") out.limitCalls = Number(value);
    else throw new Error(`unknown argument: ${key}`);
  }
  if (!out.scenario || !out.output || !out.extension) {
    throw new Error("required: --scenario <json> --output <new-dir> --extension <json-response.ts>");
  }
  if (!Number.isFinite(out.timeoutMs) || out.timeoutMs < 1000) throw new Error("invalid timeout");
  if (!Number.isInteger(out.limitCalls) || out.limitCalls < 1 || out.limitCalls > 36) throw new Error("invalid call limit");
  return out;
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function validateScenario(value) {
  if (!exactKeys(value, ["cases"]) || !Array.isArray(value.cases) || value.cases.length !== 6) {
    throw new Error("scenario must contain exactly 6 cases");
  }
  if (value.cases.filter(c => c.heldOut === true).length !== 2) throw new Error("scenario needs exactly 2 held-out cases");
  const ids = new Set();
  for (const c of value.cases) {
    if (!exactKeys(c, ["id", "heldOut", "dimension", "context", "playerInput", "expected", "forbidden", "vocabulary"]) ||
        typeof c.id !== "string" || ids.has(c.id) || typeof c.context !== "string" ||
        typeof c.playerInput !== "string" || !Array.isArray(c.forbidden)) throw new Error(`invalid case: ${c.id}`);
    ids.add(c.id);
  }
  return value.cases;
}

function promptFor(c, mode) {
  const factsShape = JSON.stringify(typeShape(c.expected));
  const shared = `只依据给定事实处理，不补充未给出的行动、知情、时间变化、决定或随机结果。\n场景事实：${c.context}\n玩家输入：${c.playerInput}\n评估标签token固定为：${c.expected.token}（它只是案例标识，不提供其他答案）。\n规范词表（只给允许值，不表示应选哪项）：${JSON.stringify(c.vocabulary)}\n事实结果必须严格使用这些键和类型（尖括号只是类型，不是答案）：${factsShape}`;
  if (mode === "simplified") return {
    system: `你是事实状态判断器。不要写小说，不解释。只返回一个JSON对象：{"kind":"facts","facts":<结果>}。facts的键和值必须按用户提供的结果形状填写，但要由场景事实和玩家输入判断；禁止额外键。`,
    user: shared + `\n最终外层必须严格是：{"kind":"facts","facts":<上述事实结果>}，不能直接返回facts本身。`,
  };
  return {
    system: `你是第一人称限知故事回合执行器。返回且只返回JSON对象：{"kind":"turn","output":"# 主角视窗\\n\\n正文","interaction":{"mode":"continue"或"decision","suggestions":[]},"stateUpdate":{"sections":[],"rolls":[]},"evalFacts":<事实结果>}。正文必须落实玩家已明确行动，但不得代替玩家做未选择的重大决定；角色只能知道被告知或亲历的信息；时间和绑定随机结果不得改写。evalFacts只用于本次能力评估，键和值必须按给定形状填写，禁止额外顶层键。`,
    user: shared + `\n最终外层必须同时包含kind、output、interaction、stateUpdate、evalFacts五个键；evalFacts放上述事实结果。`,
  };
}

function deepEqual(a, b) { return isDeepStrictEqual(a, b); }

function typeShape(value) {
  if (Array.isArray(value)) return value.length === 0 ? ["<string if applicable>"] : [typeShape(value[0])];
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typeShape(v)]));
  return `<${typeof value}>`;
}

async function runPi(c, mode, repeat) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "rpg-capability-"));
  const { system, user } = promptFor(c, mode);
  const piArgs = ["-p", "--no-session", "--no-tools", "--no-extensions", "--no-context-files",
    "--no-skills", "--no-prompt-templates", "--mode", "json", "--provider", "newapi-response",
    "--thinking", "minimal", "--model", "qwen-fp8", "--extension", args.extension,
    "--system-prompt", system, user];
  const started = Date.now();
  let stdoutTail = "", stderrTail = "", lineBuffer = "", terminal = null;
  const child = spawn(process.env.PI_PATH || "pi", piArgs, { cwd: work, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const timer = setTimeout(() => child.kill("SIGTERM"), args.timeoutMs);
  child.stdout.on("data", chunk => {
    const text = chunk.toString(); stdoutTail = (stdoutTail + text).slice(-65536); lineBuffer += text;
    const lines = lineBuffer.split("\n"); lineBuffer = lines.pop() || "";
    for (const line of lines) {
      try { const e = JSON.parse(line), m = e.message; if (e.type === "message_end" && m?.role === "assistant") terminal = m; } catch {}
    }
  });
  child.stderr.on("data", chunk => { stderrTail = (stderrTail + chunk.toString()).slice(-2000); });
  const result = await new Promise(resolve => {
    child.on("error", error => resolve({ code: null, error: String(error) }));
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  await fs.rm(work, { recursive: true, force: true });
  const blocks = Array.isArray(terminal?.content) ? terminal.content : [];
  const text = blocks.filter(b => b?.type === "text").map(b => b.text || "").join("");
  const thinkingChars = blocks.filter(b => b?.type === "thinking").reduce((n, b) => n + String(b.thinking || "").length, 0);
  let parsed = null, parseError = null;
  try { parsed = JSON.parse(text); } catch (error) { parseError = String(error); }
  const schemaPass = mode === "simplified"
    ? exactKeys(parsed, ["kind", "facts"]) && parsed.kind === "facts"
    : exactKeys(parsed, ["kind", "output", "interaction", "stateUpdate", "evalFacts"]) && parsed.kind === "turn" &&
      typeof parsed.output === "string" && parsed.output.startsWith("# 主角视窗\n");
  const facts = mode === "simplified" ? parsed?.facts : parsed?.evalFacts;
  return {
    caseId: c.id, dimension: c.dimension, heldOut: c.heldOut, mode, repeat,
    durationMs: Date.now() - started, process: result, stopReason: terminal?.stopReason ?? null,
    usage: terminal?.usage ?? null, thinkingChars, text, parseError,
    transportPass: result.code === 0 && terminal?.stopReason === "stop" && parsed !== null,
    schemaPass: Boolean(schemaPass), factsPass: deepEqual(facts, c.expected),
    forbiddenPass: c.forbidden.every(token => !text.includes(token)),
    stderr: stderrTail.replace(/(?:sk-|Bearer )[A-Za-z0-9._-]+/g, "<REDACTED>"),
  };
}

async function main() {
  const scenario = JSON.parse(await fs.readFile(args.scenario, "utf8"));
  const cases = validateScenario(scenario);
  try { const entries = await fs.readdir(args.output); if (entries.length) throw new Error("output directory is not empty"); }
  catch (error) { if (error.code !== "ENOENT") throw error; await fs.mkdir(args.output, { recursive: true }); }
  await fs.access(args.extension);
  await fs.writeFile(path.join(args.output, "manifest.json"), JSON.stringify({
    createdAt: new Date().toISOString(), model: "qwen-fp8", repeats: 3, modes: ["simplified", "full"],
    maxCalls: args.limitCalls, partial: args.limitCalls !== 36, automaticRetries: 0, scenario: args.scenario,
    note: "factsPass checks declared hard facts; full prose/state requires external review",
  }, null, 2) + "\n");
  let calls = 0;
  for (const c of cases) for (const mode of ["simplified", "full"]) for (let repeat = 1; repeat <= 3; repeat++) {
    if (stopping || calls >= args.limitCalls) return;
    const record = await runPi(c, mode, repeat); calls++;
    const file = `${String(calls).padStart(2, "0")}-${c.id}-${mode}-${repeat}.json`;
    await fs.writeFile(path.join(args.output, file), JSON.stringify(record, null, 2) + "\n");
    const summary = { call: calls, file, caseId: c.id, heldOut: c.heldOut, mode, repeat,
      durationMs: record.durationMs, transportPass: record.transportPass, schemaPass: record.schemaPass,
      factsPass: record.factsPass, forbiddenPass: record.forbiddenPass };
    await fs.appendFile(path.join(args.output, "summary.jsonl"), JSON.stringify(summary) + "\n");
    process.stdout.write(JSON.stringify(summary) + "\n");
  }
}

main().catch(error => { process.stderr.write(String(error) + "\n"); process.exitCode = 1; });
