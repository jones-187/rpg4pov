import { TurnOrchestrator } from "./turn-orchestrator";
import { FakeAgentRunner } from "./fake-agent-runner";
import { ClaudeCodeRunner } from "./claude-code-runner";

/**
 * Runner 切换 + 共享 Orchestrator 单例（Issue 7 从 story-turn route 抽出）。
 *
 * 单例必须全应用唯一：TurnOrchestrator 内部持有进程内 TurnLock，
 * 若各 route 各建实例，init 与 turn 会拿不同的锁，破坏同 storyId 串行。
 * story-turn 与 initialize 两个 route 都从这里取同一个 orchestrator。
 *
 * AGENT_RUNNER=claude 启用真实 CLI；默认 fake 保证测试/开发不依赖凭证/网络。
 * docker-compose 默认不设 AGENT_RUNNER=claude，避免无 ANTHROPIC_API_KEY 时跑不起来。
 */
export function resolveRunner() {
  if (process.env.AGENT_RUNNER === "claude") {
    return new ClaudeCodeRunner();
  }
  return new FakeAgentRunner();
}

export const orchestrator = new TurnOrchestrator(resolveRunner());
