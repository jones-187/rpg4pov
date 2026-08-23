# Pi Story Initialization 首次 A/B Acceptance

日期：2026-08-23  
范围：第一阶段真实初始化质量门；不改变 Claude 基线，不触发第二阶段删除。  
模型/provider：两条路径均固定 `qwen-fp8`、同一 provider、超时 `300000ms`，未启用 fallback。

## 执行记录

准备了 5 组虚构设定，覆盖 canon 信息密集、单/少 NPC、关系与情感、秘密与风险、显式非默认 POV。Pi 与 Claude 交替执行，每组各一次，共 **10 个 init runner executions**；这是 runner 层的 10 次初始化，不等同于底层 CLI 的请求数。此次每次均记录为 1 个 CLI attempt，完整 raw 产物、盲评材料和映射另存于受控临时目录，不把 runner 身份放入盲评材料。

| runner | executions | 成功 HTTP | 总耗时 | 平均耗时 |
| --- | ---: | ---: | ---: | ---: |
| Pi | 5 | 5/5 | 390159ms | **78032ms** |
| Claude | 5 | 5/5 | 643856ms | **128771ms** |

两条路径的 HTTP 初始化请求均返回 200；“成功”只表示链路完成，不代表质量硬门全部通过。

## 盲评揭示后的质量结果

- Pi 硬失败：S02 开场泄漏隐藏信息；S04 缺少要求的角色结构。
- Claude 硬失败：S03 出现知识冲突。
- 两位评审软分合计：Pi **242/250**，Claude **235/250**。

## 结论与后续

质量硬门未满足，**不可删除 Claude**。Claude runner、settings、prompt、fixture、专属测试与 `AGENT_RUNNER=claude` 继续保留，作为 A/B 基线和回退路径。Pi init 采用本阶段触发的两阶段退路：Phase 1 只提交完整概念 Bundle，Phase 2 只从服务端筛选的主角可见上下文生成 opening；两阶段失败均由 Orchestrator 整轮回滚。该报告不替代后续质量验收，也不把软分当作删除 Claude 的依据。
