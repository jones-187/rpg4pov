# 推理开关核验与暂停接续

日期：2026-09-20。用户确认 qwen-fp8 为本地部署，可不限调用、不必考虑模型费用；之后因助手剩余额度约 13%，要求找合适位置停止。本轮已在整合复测失败回滚后停止，没有启动长局或部署。

## 已证实

现有 Pi 镜像的真实请求构造，经 `tests/fixtures/pi-request-probe.cjs` 在 `--network none` 容器内捕获：

| 配置 | 实际请求字段 |
| --- | --- |
| reasoning=false、thinking off | 不发送关闭字段 |
| reasoning=true、qwen、thinking off | 顶层 enable_thinking=false |
| reasoning=true、qwen、thinking minimal | 顶层 enable_thinking=true |
| reasoning=true、qwen-chat-template、thinking off | chat_template_kwargs.enable_thinking=false，preserve_thinking=true |

四组均使用 qwen-fp8，输出额度均为 max_completion_tokens=16384。reasoning 描述客户端是否支持控制推理，不等于服务端已关闭推理。离线探针四组全部通过。

## 真实对照

全部使用同一隔离虚构故事开场、首个输入，保持模型、提示词与输出额度不变；不使用用户既有故事。只保留思考长度，不保存思考正文。

| 证据根目录（data/evaluations/ 下） | 结果 |
| --- | --- |
| thinking-off-q0oy4V | 顶层关闭字段无效：119,994 ms，output=16384，thinkingChars=50482，正文仅388字符，stopReason=length |
| thinking-template-4sIccF | 模板关闭生效：36,008 ms，thinkingChars=0，output=735，正常stop；JSON结构错误，未提交 |
| thinking-template-retry-uYChh8 | 12,917 ms，thinkingChars=0，output=1106，正常stop、完整JSON；REPLACE旧文本未精确命中，未提交 |
| response-integrated-AQNmF7 | 整合配置与安全重试后的真实运行：16,729 ms，两次响应均正常stop、thinkingChars=0；首次REPLACE miss，第二次JSON错误，整轮失败回滚 |

最后一组使用冻结的实际编译产物，不再由诊断脚本改写配置。第 2 回合及 30 回合对照均未运行。耗时受缓存等因素影响，不能将单样本比例当成稳定加速倍数。

## 当前代码与下一步

- 普通无工具回合及实验生成阶段使用 newapi-response 协议配置（同一服务、同一 qwen-fp8），qwen-chat-template + 显式 thinking off。初始化显式选用原 newapi 配置，避免改变工具写入路径；没有提升输出额度。
- applyStateUpdates 返回 errors 明确保证零写入，才允许在剩余尝试内反馈错误、重新生成。I/O 抛异常可能已有部分写入，仍立即交给 Orchestrator 回滚，不能重试。随机绑定沿用原结果。
- 这只是未部署的候选代码。推理耗尽问题得到定位，但关闭推理后的格式与精确状态修改可靠性仍未达标，不能宣称产品已可用。
- 下次优先验证请求层结构化输出约束，避免修补残缺JSON或放宽精确替换；也要对照叙事质量，而非只看速度。现有 Pi 安装版本支持 before_provider_request 扩展钩子（已离线检查），但尚未实现 response_format 或验证本地服务支持度。
- 后续仍使用隔离数据，保留初始化配置和模型锁定。先通过两个连续真实回合，再讨论长局。不要把本轮失败覆盖成成功，也不要重复已完成的参数对照。

主要接续文件：src/lib/pi-config.ts、src/lib/pi-runner.ts、tests/fixtures/pi-request-probe.cjs、tests/lib/pi-response-runner.test.ts。所有改动未提交；无部署，用户原有会话文件未改动。

安全重试回归已覆盖：第一候选不匹配不留下其他文件的追加；第二文件写盘失败时前一文件被回滚且不重试；绑定随机后的修正只抽样一次，后续绑定保持一致。暂停前最终 `pnpm test` 555/555 通过，`pnpm build:cli`、`git diff --check` 通过；网页构建沿用前轮成功记录，本轮配置改动后未重跑网页构建。真实失败回滚后历史仍只有 1 条开场。
