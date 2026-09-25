# 薄事实账本真实 A/B 第二轮预登记

日期：2026-09-25。场景：[`scenarios/fact-ledger-ab-heldout.json`](scenarios/fact-ledger-ab-heldout.json)。脚本：[`scripts/fact-ledger-ab-eval.cjs`](../../scripts/fact-ledger-ab-eval.cjs)。模型：`deepseek-v4.1-flash`。计划 3 个案例、两臂各 3 次、共 18 次真实调用，每臂每轮交错执行，自动重试为 0，不补跑。

## 政策

单次技术失败不再终止实验：只要某样本恰好发生 1 次真实模型调用且没有产出合格玩家输出，就记录该臂技术失败并继续后续冻结样本。若为 0 次或超过 1 次调用，视为基础设施或预算错误，立即停止且不补跑。因此，除基础设施、预算或证据写盘错误外，本轮必须尝试全部 18 个样本。

技术交付按 intention-to-treat 计：技术失败臂计为硬失败，不得被替换、补跑或剔除。A/B 技术失败率单列。语义盲审只对同一 case/repeat 的两臂都有玩家输出的 pair 进行。

## 盲审

每完成同一 pair 的两臂后生成一个 review packet，含场景标题、playerInput、priorHistory 加 opening、blindChecklist 和两个随机顺序的盲文件引用。packet 与盲文件名不含 arm。技术失败的盲文件固定写 `TECHNICAL FAILURE — NO PLAYER OUTPUT`。mapping 单独保存臂名与文件对应关系，只能在所有盲审完成后查看。

## 门槛

B 晋级讨论必须同时满足：

- 18 次全部尝试，且没有 0/多调用或证据写盘等基础设施错误；
- B 技术成功率不低于 A；
- 在至少 2/3 个案例中，B 在有效 pair 的盲审中赢得至少 2/3；若某 pair 因技术失败无法盲审，该 pair 按 B 硬失败计入该案例；
- B 没有新增隐私泄露、代玩家作重大决定或虚构时间因果的硬语义错误；
- 若 B 技术失败造成有效 pair 缺失，按硬失败计入总体，不得因剔除而改善结论。

A/B 的差异只评估冻结账本注入的效果。账本自动提取、维护和修复仍未测试，本轮结果不得用于主张启用生产默认账本。
