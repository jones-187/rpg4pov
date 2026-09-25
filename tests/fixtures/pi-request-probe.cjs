#!/usr/bin/env node
/*
 * Offline Pi request probe.
 *
 * The probe owns a loopback OpenAI-compatible endpoint, so it never needs a
 * real key or a network connection.  Keep this fixture dependency-free: it is
 * also useful for checking a Pi binary mounted from a different image.
 */

const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { promises: fs } = require("node:fs");
const { spawn } = require("node:child_process");

const TOTAL_TIMEOUT_MS = 20_000;
const CASES = [
  { reasoning: false, thinking: "off" },
  { reasoning: true, thinking: "off" },
  { reasoning: true, thinking: "minimal" },
  { reasoning: true, thinking: "off", thinkingFormat: "qwen-chat-template" },
];
const REQUEST_FIELDS = [
  "enable_thinking",
  "chat_template_kwargs",
  "max_tokens",
  "max_completion_tokens",
  "model",
  "tools",
];

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function remaining(deadline) {
  return Math.max(1, deadline - Date.now());
}

function requestSummary(body) {
  const request = {};
  for (const field of REQUEST_FIELDS) {
    if (own(body, field)) request[field] = body[field];
  }
  return request;
}

function sseResponse(body) {
  const id = "pi-request-probe";
  const model = typeof body.model === "string" ? body.model : "qwen-fp8";
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  return [
    `data: ${JSON.stringify(chunk)}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) {
        reject(new Error("request body is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(new Error(`invalid JSON request: ${error.message}`));
      }
    });
    request.on("error", reject);
  });
}

function createProbeServer() {
  let requestHandler;
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
        response.writeHead(404).end();
        return;
      }
      const body = await readJsonBody(request);
      if (!requestHandler) {
        response.writeHead(500).end();
        return;
      }
      requestHandler(body);
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.end(sseResponse(body));
    } catch (error) {
      response.writeHead(400).end();
      if (requestHandler) requestHandler(undefined, error);
    }
  });

  return {
    server,
    setRequestHandler(handler) {
      requestHandler = handler;
    },
  };
}

function listen(server, deadline) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("loopback server listen timed out"));
    }, remaining(deadline));
    server.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.listen(0, "127.0.0.1", () => {
      clearTimeout(timer);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("loopback server did not provide a port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function waitForChild(child, deadline) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 500);
      killTimer.unref();
      reject(new Error("pi process timed out"));
    }, remaining(deadline));
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4_096);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr });
    });
  });
}

function waitForRequest(setHandler, deadline) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no OpenAI request received")), remaining(deadline));
    setHandler((body, error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(body);
    });
  });
}

async function runCase(
  { reasoning, thinking, thinkingFormat = "qwen" },
  baseUrl,
  configDir,
  deadline,
  setRequestHandler,
) {
  const models = {
    providers: {
      newapi: {
        baseUrl,
        api: "openai-completions",
        apiKey: "pi-request-probe-key",
        models: [
          {
            id: "qwen-fp8",
            reasoning,
            compat: { thinkingFormat, supportsDeveloperRole: false },
          },
        ],
      },
    },
  };
  await fs.writeFile(path.join(configDir, "models.json"), `${JSON.stringify(models, null, 2)}\n`, {
    mode: 0o600,
  });

  const request = waitForRequest(setRequestHandler, deadline);
  const piPath = process.env.PI_PROBE_BIN?.trim() || process.env.PI_PATH?.trim() || "/usr/local/bin/pi";
  const args = [
    "-p",
    "--no-session",
    "--no-tools",
    "--no-extensions",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--mode",
    "json",
    "--thinking",
    thinking,
    "--offline",
    "--provider",
    "newapi",
    "--model",
    "qwen-fp8",
    "probe",
  ];
  const child = spawn(piPath, args, {
    cwd: configDir,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: configDir,
      OPENAI_API_KEY: "pi-request-probe-key",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    const childResult = waitForChild(child, deadline);
    const [body, result] = await Promise.all([request, childResult]);
    if (result.code !== 0) {
      throw new Error(
        `pi exited with ${result.code ?? "null"}${result.signal ? ` (${result.signal})` : ""}${result.stderr ? `: ${result.stderr.trim()}` : ""}`,
      );
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("OpenAI request body was not an object");
    }
    if (body.model !== "qwen-fp8") throw new Error(`unexpected model: ${body.model}`);
    if (thinkingFormat === "qwen-chat-template") {
      if (own(body, "enable_thinking")) {
        throw new Error("qwen-chat-template unexpectedly sent top-level enable_thinking");
      }
      if (body.chat_template_kwargs?.enable_thinking !== false) {
        throw new Error(
          `unexpected chat_template_kwargs.enable_thinking: ${body.chat_template_kwargs?.enable_thinking}`,
        );
      }
    } else {
      if (reasoning === false && own(body, "enable_thinking")) {
        throw new Error("reasoning=false unexpectedly sent enable_thinking");
      }
      if (reasoning === true && body.enable_thinking !== (thinking !== "off")) {
        throw new Error(
          `unexpected enable_thinking for reasoning=${reasoning}, thinking=${thinking}: ${body.enable_thinking}`,
        );
      }
    }

    return { request: requestSummary(body), exitCode: result.code };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
}

async function main() {
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-request-probe-"));
  const { server, setRequestHandler } = createProbeServer();
  let child;
  try {
    const port = await listen(server, deadline);
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const results = [];
    for (const testCase of CASES) {
      results.push(await runCase(testCase, baseUrl, configDir, deadline, setRequestHandler));
    }
    for (const result of results) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  } finally {
    server.close();
    if (child && !child.killed) child.kill("SIGTERM");
    await fs.rm(configDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`pi-request-probe: ${error.message}\n`);
  process.exitCode = 1;
});
