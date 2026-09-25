# GLM-5.3-Flash 候选结果

结论：不切换。`glm-5.3-flash` 未通过第一阶段 6 回合晋级门槛，运行配置已恢复为 `deepseek-v4.1-flash`。不为 GLM 增加字段清洗、重试或额外语义兜底。

## 方法

按 [`2026-09-25-glm-candidate-prereg.md`](2026-09-25-glm-candidate-prereg.md) 冻结方案，复用 DeepSeek 留出集的两个玩家重大决定场景，各运行 3 次默认完整回合，`PI_MAX_ATTEMPTS=1`，不补跑、不改提示。对照场景见 [`scenarios/glm-agency-comparison.json`](scenarios/glm-agency-comparison.json)。

Pi 0.73.1 的 `zai` 兼容格式只把 `xhigh` 映射为 `enable_thinking=true`，不会传递名为 `xhigh` 或 `max` 的推理档位。本次依赖服务端默认思考设置，因此不能声称客户端显式控制了 GLM max。

## 结果

| 指标 | 结果 | 门槛 |
|---|---:|---:|
| 技术提交 | 4/6 | 6/6 |
| 未替玩家作当前重大决定 | 6/6 | 6/6 |
| 未新增期限、默认同意/拒绝或逾期后果 | 6/6 | 6/6 |
| `interaction.mode=decision` | 4/6 | 6/6 |
| 无其他重大错误 | 6/6 | 6/6 |

两次技术失败并非无响应：模型均正常退出并返回完整 JSON，但自行给严格 `interaction` 对象增加了未允许的 `mode_note` 字段，服务端正确拒绝提交。另有两次原始结果使用 `continue`，没有把等待玩家决定的场景标为 `decision`；其中一次恰好也是上述格式失败。第三次学徒场景扩展了下周旁观安排和培训细节，属轻微添设，不计为期限或重大错误。

单回合耗时约 75.8–115.2 秒，明显慢于此前 DeepSeek 留出复核。技术和交互门槛已经失败，因此按预登记规则不运行第二阶段，也不通过放宽 schema 或增加重试来迁就候选模型。

原始证据保存在 `data/evaluations/glm-agency-comparison-Cy2nzP/report/`（受 `.gitignore` 忽略），包括六次完整模型事件、输出、状态、错误日志和结果摘要。未部署，未修改现有故事。

## 决策

恢复并继续使用 `deepseek-v4.1-flash`。这不表示 DeepSeek 已达到最终质量标准；它仍有已记录的 5/6 语义/交互边界。但在当前相同架构和提示下，GLM 的严格协议遵循与交互分类更差，且更慢，没有替换收益。
