import { TurnOrchestrator } from "./turn-orchestrator";
import { FakeAgentRunner } from "./fake-agent-runner";
import { ClaudeCodeRunner } from "./claude-code-runner";
import { PiRunner } from "./pi-runner";
import type { AgentRunner, TurnRequest, TurnResult } from "./agent-runner";

/**
 * Runner 切换 + 共享 Orchestrator 单例（Issue 7 从 story-turn route 抽出）。
 *
 * 单例必须全应用唯一：TurnOrchestrator 内部持有进程内 TurnLock，
 * 若各 route 各建实例，init 与 turn 会拿不同的锁，破坏同 storyId 串行。
 * story-turn 与 initialize 两个 route 都从这里取同一个 orchestrator。
 *
 * AGENT_RUNNER=pi 启用统一 PiRunner（init/turn 共用同一个实例）。
 * AGENT_RUNNER=claude 启用真实执行（性能优化分支起按 task 分发）：
 * - task="turn"  → PiRunner（pi coding agent：预注入上下文 + 合并写盘，29-43s）
 * - task="init"  → ClaudeCodeRunner（A/B 基线，第一阶段保留）
 * 默认 fake 保证测试/开发不依赖凭证/网络。
 * docker-compose 默认不设 AGENT_RUNNER=claude，避免无凭证时跑不起来。
 */

/** 按 req.task 把回合分发给对应 runner（Claude A/B 基线专用）。 */
class TaskDispatchRunner implements AgentRunner {
  constructor(
    private readonly turnRunner: AgentRunner,
    private readonly initRunner: AgentRunner,
  ) {}

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const runner = req.task === "init" ? this.initRunner : this.turnRunner;
    return runner.runTurn(req);
  }
}

export function resolveRunner(): AgentRunner {
  const publicContinuityCard = process.env.PUBLIC_CONTINUITY_CARD === "1";
  if (process.env.AGENT_RUNNER === "pi") {
    return new PiRunner({ publicContinuityCard });
  }
  if (process.env.AGENT_RUNNER === "claude") {
    return new TaskDispatchRunner(
      new PiRunner({ publicContinuityCard }),
      new ClaudeCodeRunner(),
    );
  }
  return new FakeAgentRunner();
}

export const orchestrator = new TurnOrchestrator(resolveRunner());
