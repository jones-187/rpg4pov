# Public Continuity Card 生命周期

Public Continuity Card 的生命周期入口是 `src/lib/fact-ledger.ts` 中的纯函数：

```ts
applyFactLedgerUpdate(current: FactLedger, candidate: unknown): FactLedger
```

调用方只需要提交当前卡片和 unknown candidate。解析、严格格式校验、id 冲突检查、更新、带证据解决、退役、上限检查、悬空因果检查和最终账本完整性验证都由该函数完成。失败时抛出异常并整体拒绝，不产生部分应用，也不修改 `current` 或 `candidate`。成功时返回等价的新对象；空 candidate 合法，返回内容等价的新卡片。

## 候选格式

candidate 固定为以下五个字段，缺少字段或出现额外字段都拒绝：

```json
{
  "version": "1",
  "appendEvents": [],
  "upsertKnowledgeBoundaries": [],
  "resolve": [],
  "retireIds": []
}
```

`appendEvents` 复用事件严格校验，但只允许 `visibility=public`。新事件 id 不得与任何现存或同 candidate 更早追加的事件 id、现存或更新后的 boundary id 冲突；`causedBy` 可引用仍保留的现存事件或同 candidate 中更早追加的事件。禁止 private 正文进入卡片维护路径。

`upsertKnowledgeBoundaries` 按 id 新建或更新；holders 为 1 到 16 个非空唯一字符串，并按字典序规范化。

事件的 `kind` 为 `event`、`unknown-cause` 或 `open-decision`；旧数据缺少时按普通 `event` 读取。`resolve` 只能解决后两种未决项，而且必须列出至少一个最终仍保留的公开事件作为证据。`retireIds` 只用于普通事件或 boundary 的明确清理，不能绕过证据要求删除未决项。两类操作不得重叠，也不能与追加或 upsert 复用 id。最终账本不能出现悬空 `causedBy`。

## 不变量

- event id 与 boundary id 共用一个 id 空间，全局不允许重复。
- 事件数量最多 64，显式 boundary 数量最多 64；超限整体拒绝，不自动淘汰。
- 不做语义推断、自动摘要、模糊匹配、重试或自动修复。
- private 事件及其传递派生事件在渲染中只输出抽象 Knowledge Boundary；显式 boundary 也只输出 holders，不输出 boundary id。
- 相同 holders 的显式 boundary 与自动生成 boundary 在渲染中去重。
- 更新是原子语义：任何一步无效，整个 candidate 都不应用。

## 当前边界

该接口已通过默认关闭的 `PUBLIC_CONTINUITY_CARD=1` 实验开关接入 Pi 正式回合。启用后，服务端从工作区根目录 `continuity-card.json` 读取权威卡片；文件缺失时仅在内存中使用空卡片，格式损坏则整轮失败，绝不静默重置。模型完整响应必须额外提交 `factLedgerUpdate`，但不能直接写权威文件。服务端在任何写盘前校验正文、交互、状态更新和卡片更新，随后在现有 TurnOrchestrator 快照窗口内统一提交；后续任一步失败均整轮回滚。

现有冻结 A/B scenario 和缺省 `knowledgeBoundaries` 字段的旧 JSON 仍可解析；旧四字段 Pi 响应在开关关闭时保持严格不变。场景分离实验暂不与本功能混用。

下一步不是继续增加规则，而是用真实模型对启用/禁用两臂各重复三轮，分别评价格式成功率、因果连续性、角色知情边界、未决事项处理和文学体验。只有实测达到门槛后才能考虑默认开启。
