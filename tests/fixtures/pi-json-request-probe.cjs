#!/usr/bin/env node
/*
 * Offline Pi request-format probe.
 *
 * The repository's JSON-response extension handles before_provider_request,
 * while a loopback OpenAI-compatible server captures the request.  The caller
 * can run this fixture inside a Pi image with --network none: no real model or
 * key is involved.
 */

const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { promises: fs } = require("node:fs");
const { spawn } = require("node:child_process");

const TOTAL_TIMEOUT_MS = 20_000;

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function remaining(deadline) {
  return Math.max(1, deadline - Date.now());
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

function sseResponse(body) {
  const chunk = {
    id: "pi-json-request-probe",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: typeof body.model === "string" ? body.model : "qwen-fp8",
    choices: [{ index: 0, delta: { content: '{"ok":true}' }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  return [`data: ${JSON.stringify(chunk)}\n\n`, "data: [DONE]\n\n"].join("");
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
      if (!requestHandler) throw new Error("request handler was not installed");
      requestHandler(body);
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.end(sseResponse(body));
    } catch (error) {
      if (!response.headersSent) response.writeHead(400);
      response.end();
      requestHandler?.(undefined, error);
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

function waitForRequest(setHandler, deadline) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) reject(new Error("no OpenAI request received"));
    }, remaining(deadline));
    setHandler((body, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(body);
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

async function main() {
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-json-request-probe-"));
  const extensionPath =
    process.env.PI_JSON_EXTENSION_PATH?.trim() ||
    path.resolve(__dirname, "../../pi-extensions/json-response.ts");
  const { server, setRequestHandler } = createProbeServer();
  let child;

  try {
    const port = await listen(server, deadline);
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const models = {
      providers: {
        newapi: {
          baseUrl,
          api: "openai-completions",
          apiKey: "offline-fixture-only",
          models: [
            {
              id: "qwen-fp8",
              reasoning: false,
              compat: { thinkingFormat: "qwen", supportsDeveloperRole: false },
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
      "--extension",
      extensionPath,
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--mode",
      "json",
      "--thinking",
      "off",
      "--offline",
      "--provider",
      "newapi",
      "--model",
      "qwen-fp8",
      "probe",
    ];
    child = spawn(piPath, args, {
      cwd: configDir,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: configDir,
        OPENAI_API_KEY: "offline-fixture-only",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });

    const [body, result] = await Promise.all([request, waitForChild(child, deadline)]);
    if (result.code !== 0) {
      throw new Error(
        `pi exited with ${result.code ?? "null"}${result.signal ? ` (${result.signal})` : ""}${result.stderr ? `: ${result.stderr.trim()}` : ""}`,
      );
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("OpenAI request body was not an object");
    }
    if (body.response_format?.type !== "json_object") {
      throw new Error(`response_format hook was not applied: ${JSON.stringify(body.response_format)}`);
    }
    if (own(body, "tools")) {
      throw new Error(`--no-tools unexpectedly sent tools: ${JSON.stringify(body.tools)}`);
    }

    process.stdout.write(
      `${JSON.stringify({
        extension: path.basename(extensionPath),
        response_format: body.response_format,
        toolsFieldPresent: own(body, "tools"),
        model: body.model,
        exitCode: result.code,
      })}\n`,
    );
  } finally {
    server.close();
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await fs.rm(configDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`pi-json-request-probe: ${error.message}\n`);
  process.exitCode = 1;
});
