import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * pi coding agent 的运行时配置（性能优化分支）。
 *
 * pi 不读 ANTHROPIC_* 环境变量做自定义网关，而是用 ~/.pi/agent/models.json
 * 声明 provider + 模型。本模块在 runner 启动时从 ANTHROPIC_* 环境变量
 * 幂等生成该文件（已存在且内容一致则跳过写入），密钥不进镜像、不进 git。
 *
 * 实测依据（2026-08 性能探索）：
 * - 走 NewAPI 的 OpenAI 兼容端点（/v1），thinkingFormat "qwen" 可下发
 *   enable_thinking 参数（Anthropic 端点会被网关吞掉）
 * - reasoning:false 是 3 工具并行成功那次跑的配置；:off 档会破坏 qwen
 *   工具调用可靠性（两次废回合实证），禁用
 * - 模型锁定 qwen-fp8（项目约束；可经 ANTHROPIC_MODEL 显式覆盖以便未来验收）
 */

/** 默认模型：本分支验收约束锁定 qwen-fp8 */
const DEFAULT_PI_MODEL = "qwen-fp8";

export function resolvePiModel(): string {
  return process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_PI_MODEL;
}

/** pi agent 目录（~/.pi/agent；测试经 PI_HOME 覆盖） */
export function resolvePiAgentDir(): string {
  const home = process.env.PI_HOME?.trim() || path.join(os.homedir(), ".pi");
  return path.join(home, "agent");
}

/** NewAPI 的 Anthropic 兼容根 → OpenAI 兼容根（追加 /v1，幂等） */
function resolveOpenAiBaseUrl(): string {
  const base = process.env.ANTHROPIC_BASE_URL?.trim().replace(/\/+$/, "");
  if (!base) throw new Error("pi runner requires ANTHROPIC_BASE_URL");
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

function resolveApiKey(): string {
  const key =
    process.env.ANTHROPIC_AUTH_TOKEN?.trim() || process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) throw new Error("pi runner requires ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY");
  return key;
}

/** 生成 models.json 内容（单一 provider，双保险不写多余模型） */
export function buildPiModelsJson(): string {
  return JSON.stringify(
    {
      providers: {
        newapi: {
          baseUrl: resolveOpenAiBaseUrl(),
          api: "openai-completions",
          apiKey: resolveApiKey(),
          models: [
            {
              id: resolvePiModel(),
              reasoning: false,
              compat: { thinkingFormat: "qwen", supportsDeveloperRole: false },
            },
          ],
        },
      },
    },
    null,
    2,
  );
}

/**
 * 确保 ~/.pi/agent/models.json 存在且与当前环境一致。
 * 内容漂移（换网关/换密钥/换模型）时自动重写。
 * @returns models.json 绝对路径
 */
export async function ensurePiConfig(): Promise<string> {
  const dir = resolvePiAgentDir();
  const file = path.join(dir, "models.json");
  const want = buildPiModelsJson() + "\n";
  let current: string | null = null;
  try {
    current = await fs.readFile(file, "utf8");
  } catch {
    // 不存在则写入
  }
  if (current !== want) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, want, { mode: 0o600 });
  }
  return file;
}
