import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveAgentModel } from "./agent-model";

/**
 * pi coding agent 的运行时配置（性能优化分支）。
 *
 * pi 不读 ANTHROPIC_* 环境变量做自定义网关，而是用 ~/.pi/agent/models.json
 * 声明 provider + 模型。本模块在 runner 启动时从 ANTHROPIC_* 环境变量
 * 幂等生成该文件（已存在且内容一致则跳过写入），密钥不进镜像、不进 git。
 *
 * 实测依据（2026-08 性能探索，2026-09 模型切换）：
 * - 走 NewAPI 的 OpenAI 兼容端点（/v1）；模型兼容格式必须显式声明，
 *   因为自定义 provider/网关地址无法由 Pi 自动识别模型厂商。
 * - 初始化保留 reasoning:false 的工具调用配置；普通无工具响应使用独立
 *   provider 声明 reasoning 能力，由 CLI 显式选择推理开关。
 * - 当前模型硬锁 deepseek-v4.1-flash；普通完整响应使用 DeepSeek
 *   thinking 格式。冲突配置直接失败，不回退。
 */

/** 兼容既有调用名；实际策略由共享的模型白名单负责。 */
export const resolvePiModel = resolveAgentModel;

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

/** 同一服务、同一锁定模型的两种协议配置；不修改初始化工具调用语义。 */
export function buildPiModelsJson(): string {
  const baseUrl = resolveOpenAiBaseUrl();
  const apiKey = resolveApiKey();
  const model = resolvePiModel();
  return JSON.stringify(
    {
      providers: {
        newapi: {
          baseUrl,
          api: "openai-completions",
          apiKey,
          models: [
            {
              id: model,
              reasoning: false,
              compat: { thinkingFormat: "deepseek", supportsDeveloperRole: false },
            },
          ],
        },
        "newapi-response": {
          baseUrl,
          api: "openai-completions",
          apiKey,
          models: [{
            id: model,
            reasoning: true,
            compat: { thinkingFormat: "deepseek", supportsDeveloperRole: false },
          }],
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
