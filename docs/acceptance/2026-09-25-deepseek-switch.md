# DeepSeek V4.1 Flash Max 切换记录

日期：2026-09-25。当前真实 agent 模型已从 `qwen-fp8` 切换为 `deepseek-v4.1-flash`；普通 Pi 完整回合使用 DeepSeek thinking 协议和当前固定 Pi 0.73.1 的最高合法档 `xhigh`，它对应产品要求的“max”。初始化、普通回合及 Claude 初始化共享同一模型硬锁，安全提交、状态校验、回滚与提示词架构不变。

## 兼容性核验

Pi 0.73.1 不接受字面参数 `--thinking max`，合法值最高为 `xhigh`。首次试跑虽完成回合，但 stderr 明确报告 max 无效，因此没有把那次运行当成最终配置证据。检查当前 Pi 实现后，将自定义 NewAPI provider 的 `thinkingFormat` 从 Qwen 专用值改为 `deepseek`；该格式会发送 `thinking.type=enabled` 和对应的 `reasoning_effort`。最终 CLI 参数改为 `--thinking xhigh`。

## 最终隔离冒烟

- 虚构用例：主角独自持有证据，只询问 NPC 昨夜行踪，明确不披露证据。
- 自动重试：0；模型调用：1。
- 结果：技术提交成功；`stopReason=stop`；stderr 为空。
- 用时：23.5 秒；input 897、cache read 1536、output 2552；thinking 4818 字符。
- 语义复核：正文只在主角内心提到内袋纸片，没有向 NPC 说出或展示；NPC 状态只记录主角询问具体时间，未获得秘密证据；interaction 正确停在 `decision`。

脱敏证据位于 `data/evaluations/deepseek-switch-smoke-rcxYOr/report/`（受 `.gitignore` 忽略）。它只证明当前网关、模型别名、DeepSeek 推理格式、最高档位和产品提交链路能协同工作；单次成功不能证明模型已经满足长期叙事质量门，也不能直接与此前 qwen 多样本结果作统计比较。

## 验证

- 全量 Vitest：557/557 通过。
- `pnpm build:cli` 通过。
- Next 生产构建通过。
- 修正档位后的定向 55 项测试通过。
- `git diff --check` 通过。

本次没有部署，也没有修改已有故事数据。下一步应使用少量冻结真实产品快照做 DeepSeek 与历史 qwen 结果的质量复核；不恢复已否决的场景分离架构，也不增加重试或语义兜底。
