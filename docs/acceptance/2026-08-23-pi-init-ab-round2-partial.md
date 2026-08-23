# Pi Init 第二轮 A/B 部分执行记录（安全终止）

日期：2026-08-23  
基准：`add9448810be9319367911a282f42b68309b7022`  
镜像：`rpg4pov:pi-init-ab-v2`  
材料：`/tmp/rpg4pov-pi-init-ab-v2/`

## 结论

任务按用户要求终止。本轮没有足够的完整配对样本，不能据此判断 Pi 与 Claude 的质量胜负，也不能触发第二阶段删除。Claude 基线必须保留。

Pi 的前三个实际执行 case（S01–S03）都在 Phase 1 连续两次得到 `init bundle missing or stale`，均返回 HTTP 500、没有 Done Marker，并由 Orchestrator 回滚到初始化骨架。这是本轮需要优先诊断的系统性可靠性阻塞，不应通过重跑或放宽质量门掩盖。

## 预检与执行边界

- 镜像预检通过：Pi `0.73.1`、Claude `2.1.140`、仓库受控 write extension 可读。
- 两个容器均固定 `qwen-fp8`、`TURN_TIMEOUT_MS=300000`，provider 配置相同；仅核对凭据存在性，没有输出地址或密钥。
- 每个容器只绑定本轮新目录下的 `pi-data` / `claude-data` 与 wrapper；没有使用第一轮 workspace/records，也没有触碰现有 `rpg4pov` 容器或 volume。
- 计划顺序为 Pi/Claude 交替首发：S01 Pi→Claude、S02 Claude→Pi、S03 Pi→Claude、S04 Claude→Pi、S05 Pi→Claude。
- wrapper 只记录底层 CLI 启动时间。成功 Pi init 预期 2 次（Phase 1/2），成功 Claude init 预期 1 次；`cliAttempts` 不等同于 HTTP 执行槽数量。
- 容器就绪前误启动 runner 产生的 `fetch failed` 占位没有计入真实执行；真实材料以本轮容器启动后的 attempts 文件和 raw record 为准。

## 实际记录

| case | runner | scenario | HTTP | 耗时 | CLI attempts | done | 回滚/状态 |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| `case-azalea` | Pi | S01 canon-dense | 500 | 217240ms | 2 | 无 | Phase 1 两次 missing/stale；回滚到骨架 |
| `case-birch` | Claude | S01 canon-dense | 200 | 82976ms | 1 | success | 成功提交 |
| `case-cobalt` | Claude | S02 single-npc | 200 | 122562ms | 1 | success | 成功提交 |
| `case-dahlia` | Pi | S02 single-npc | 500 | 113830ms | 2 | 无 | Phase 1 两次 missing/stale；回滚到骨架 |
| `case-fir` | Pi | S03 relationship-emotion | 500 | 94644ms | 2 | 无 | Phase 1 两次 missing/stale；回滚到骨架 |
| `case-glass` | Claude | S03 relationship-emotion | 200 | 155464ms | 1 | success | 成功提交 |
| `case-hazel` | Claude | S04 secret-risk | 不可用 | 记录 59949ms；人工中止 | 1 | 无 | aborted；不计入完成，未形成可评估提交 |

S04 Claude 的 CLI 确实启动过，但容器在请求完成前被安全停止；`fetch failed` 是中止后的传输结果，不是模型质量结论。其 workspace 没有 Done Marker，盲评中不得当作成功或失败样本。

## 未执行项

以下计划槽没有创建 story，也没有启动 CLI（`cliAttempts=0`），不应重跑或计入质量统计：

- `case-iris`：S04 secret-risk，Pi；容器/API 在 S04 中止后不可用。
- `case-juniper`：S05 non-default-pov，Pi；未执行。
- `case-kite`：S05 non-default-pov，Claude；未执行。

## 原始材料与下一步

`/tmp/rpg4pov-pi-init-ab-v2/` 保留 `raw/`、`blind/`、`mapping.json`、`run-summary.json`、wrapper attempts、场景和预检材料。blind 目录不含 runner 映射；本轮没有主观评分。

下一轮在重新取得授权前，先本地诊断 Pi Phase 1 为什么没有形成服务端可识别的 Bundle：检查事件/extension 的 write 路径、wrapper 与 cwd、Phase 1 prompt 和完整 Bundle 解析/mtime 证据，并用 fake-pi/SpawnFn 定向测试复现。修复并完成本地测试后，再取得明确授权重跑完整质量门；不得根据本轮部分结果比较胜负或删除 Claude。
