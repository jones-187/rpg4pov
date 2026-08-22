# 回合执行从 claude CLI agent 循环迁移到 pi（预注入上下文 + 合并写盘）

2026-08 性能优化分支：Story Turn（热路径，目标 ≤60s）改由 pi coding agent 执行——服务端预注入全部 workspace 上下文（模型禁读文件）、模型一次性并行写 3 个产物（output.md / interaction.json / state-update.md 状态变更单文件）、服务端解析合并并写 done.json；Story Initialization（每故事一次、无延迟压力）保留 claude CLI agentic 路径。runner 经 `TaskDispatchRunner` 按 `req.task` 分发（`AGENT_RUNNER=claude` 时生效），锁/快照/回滚/输出契约链路不变。

## 为什么（实测数字，2026-08-22，NewAPI 网关 + qwen-fp8）

旧路径每回合 ~3 分钟：claude CLI 冷启动 + agent 循环 ~15-25 次 LLM 往返（读 9 类文件 + 写 6+ 文件），qwen 是 thinking 模型且每趟往返都要先消化 CLI 的编码助手 system prompt（同任务 8.2s vs 换故事身份后 0.74s）。全尺寸优化尝试（预注入、换 harness、换模型、resume 会话复用、effort 档位）后各路径耗时：claude CLI 132-187s、Codex 174s、opencode 272s、直连单发 44-148s（qwen thinking 不可控烧穿 8k token；glm/minimax 受网关通道不稳拖累）；pi + 瘦身契约（8.1k→3.2k 字符）+ 合并写盘 + 重试装甲实测 29-61s（典型暖路径 ~43s）。生产端到端验收：init 116s、turn 冷 61s / 暖 43s。

## Considered Options（被否决的备选）

- **直连 HTTP 单次生成（B1）**：往返最少，但 qwen 经 Anthropic 协议 thinking 不可控（budget_tokens / no_think 均被网关无视），OpenAI 协议下 pi 的 `thinkingFormat:"qwen"` 同样关不掉却显著收敛；单发大输出受网关通道不稳（glm-5.2 同载荷 3 跑 1 成、input 被坏通道吞掉）制约。保留为未来网关修复后的候选。
- **resume 会话复用（"初始化一次 + /clear"）**：实测可用且快，但会话记忆 > 指令 > 磁盘——模型一次路径漂移后，明确指令也拦不住后续回合重复漂移（传染性），与"磁盘为唯一真相 + 回滚语义"冲突，否决。
- **更高效的 agent harness（Codex / opencode / Agent SDK）**：全尺寸实测 174-272s，harness 差异只值几秒，赢不了"往返数 × 每趟成本"的乘法。

## Consequences

- **随机判定经预掷随机数池进入 pi 回合路径**（初版"暂不进入"已被推翻——随机判定是产品红线，不得缺席任何 turn 路径）：pi prompt 禁 bash（工具调用可靠性），agent 无法调 roll-choice CLI；等价通道为服务端 crypto 预生成 6 个 `[0,1)` 样本注入 prompt 末尾，模型按序消耗做 Roll Choice，在 state-update.md `=== RANDOM ===` 段申报，服务端用自持样本**重算权威结果**按同形状落账 random-rolls.jsonl（`random-tool.ts recordPoolRoll`），orchestrator 泄密守卫零改动继续生效。信任模型与 claude 路径对齐：样本真随机（服务端 crypto）、候选权重由 agent 自定（claude 路径同样如此）、服从性靠 prompt 约束；服务端额外多一层申报不一致（mismatch）诊断信号。池在回合内跨重试固定（防故意失败刷点）；消耗严格按 R1,R2,… 顺序核对（防挑号）。
- **qwen 工具调用可靠性装甲**：实测 1/6 概率"口述不写盘"（输出文件缺失），PiRunner 自动重试一次（`PI_MAX_ATTEMPTS`，默认 2）。
- **权限治理换轨**（见 claude-code-runner 注释）：claude CLI 2.1.140 + 网关环境下 settings 路径规则对 Write 调用完全不匹配，init 改 `--tools=Read,Write` + auto；orchestrator 新增受保护路径基线守卫（story.md / turn/input.md 与既有 history 守卫同级，fail-closed）。
- 模型锁定 qwen-fp8（项目约束）；pi 锁 0.73.1（Dockerfile）。
