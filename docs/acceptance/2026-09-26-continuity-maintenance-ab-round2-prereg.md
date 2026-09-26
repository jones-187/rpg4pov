# 公开连续性卡片自动维护真实 A/B：Round 2 预登记

Round 2 独立于第一轮统计。第一轮结果见 [`2026-09-26-continuity-maintenance-ab-result.md`](2026-09-26-continuity-maintenance-ab-result.md)：maintained 因子项 schema 说明不完整仅 2/18 技术通过，无法语义比较。

本轮只改变一项：系统提示完整列出 `appendEvents` 的九个必填字段，以及 knowledge boundary、resolve 的精确子项结构，并强调空数组也必须保留。严格解析器、生命周期规则、模型、推理档、冻结场景、两臂、运行顺序、调用预算、盲审方式和晋级门槛全部保持第一轮预登记不变。

- 模型：`deepseek-v4.1-flash`，Pi `xhigh`（产品侧 max）
- 场景：[`scenarios/continuity-maintenance-ab.json`](scenarios/continuity-maintenance-ab.json)
- 3 案例 × 2 臂 × 3 次 × 2 回合，共 36 次真实调用
- `PI_MAX_ATTEMPTS=1`，不重试、不补跑
- static：两回合读取同一初始冻结卡片
- maintained：第一回合维护 canonical card，第二回合读取提交结果

技术门槛仍为 maintained 技术成功率不低于 static。语义门槛仍为至少 2/3 案例中赢得至少 2/3 配对，且无新增硬语义、隐私或玩家自主权错误。若精确 schema 后 maintained 仍主要产生结构合法但语义错误的更新，则归为模型/上下文能力问题，不继续增加字段修复或自动语义兜底。
