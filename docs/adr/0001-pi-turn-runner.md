# 回合执行从 claude CLI agent 循环迁移到 pi（预注入上下文 + 合并写盘）

2026-08 性能优化分支：Story Turn（热路径，目标 ≤60s）与 Story Initialization 均可由 Pi Runner 执行——服务端按 `req.task` 选择 prompt；turn 预注入全部 workspace 上下文并写增量 State Update Bundle，init 先以 Phase 1 预注入用户 canon/骨架并提交完整 Init Workspace Bundle，再以 Phase 2 从已应用概念文件构造主角可见 opening context，最后由服务端校验并写 done.json。`AGENT_RUNNER=pi` 使用单一 PiRunner；`AGENT_RUNNER=claude` 仍经 `TaskDispatchRunner` 保留 turn→Pi、init→Claude 的 A/B 基线。锁/快照/回滚/输出契约链路不变。

第一阶段当前状态：Pi init 的两阶段隔离、阶段 allowlist extension、manifest 纵深校验和 opening 预览竞态守卫已落地；首次真实 A/B 结果见 [`docs/acceptance/2026-08-23-pi-init-ab-acceptance.md`](../acceptance/2026-08-23-pi-init-ab-acceptance.md)。A/B 尚未满足删除 Claude 的质量门，因此 Claude 路径继续作为基线与退路。

## 为什么（实测数字，2026-08-22，NewAPI 网关 + qwen-fp8）

旧路径每回合 ~3 分钟：claude CLI 冷启动 + agent 循环 ~15-25 次 LLM 往返（读 9 类文件 + 写 6+ 文件），qwen 是 thinking 模型且每趟往返都要先消化 CLI 的编码助手 system prompt（同任务 8.2s vs 换故事身份后 0.74s）。全尺寸优化尝试（预注入、换 harness、换模型、resume 会话复用、effort 档位）后各路径耗时：claude CLI 132-187s、Codex 174s、opencode 272s、直连单发 44-148s（qwen thinking 不可控烧穿 8k token；glm/minimax 受网关通道不稳拖累）；pi + 瘦身契约（8.1k→3.2k 字符）+ 合并写盘 + 重试装甲实测 29-61s（典型暖路径 ~43s）。生产端到端验收：init 116s、turn 冷 61s / 暖 43s。

## Considered Options（被否决的备选）

- **直连 HTTP 单次生成（B1）**：往返最少，但 qwen 经 Anthropic 协议 thinking 不可控（budget_tokens / no_think 均被网关无视），OpenAI 协议下 pi 的 `thinkingFormat:"qwen"` 同样关不掉却显著收敛；单发大输出受网关通道不稳（glm-5.2 同载荷 3 跑 1 成、input 被坏通道吞掉）制约。保留为未来网关修复后的候选。
- **resume 会话复用（"初始化一次 + /clear"）**：实测可用且快，但会话记忆 > 指令 > 磁盘——模型一次路径漂移后，明确指令也拦不住后续回合重复漂移（传染性），与"磁盘为唯一真相 + 回滚语义"冲突，否决。
- **更高效的 agent harness（Codex / opencode / Agent SDK）**：全尺寸实测 174-272s，harness 差异只值几秒，赢不了"往返数 × 每趟成本"的乘法。

## Consequences

- **随机判定经预掷随机数池进入 pi 回合路径**（初版"暂不进入"已被推翻——随机判定是产品红线，不得缺席任何 turn 路径）：pi prompt 禁 bash（工具调用可靠性），agent 无法调 roll-choice CLI；等价通道为服务端 crypto 预生成 6 个 `[0,1)` 样本注入 prompt 末尾，模型按序消耗做 Roll Choice，在 state-update.md `=== RANDOM ===` 段申报，服务端用自持样本**重算权威结果**按同形状落账 random-rolls.jsonl（`random-tool.ts recordPoolRoll`），orchestrator 泄密守卫零改动继续生效。信任模型与 claude 路径对齐：样本真随机（服务端 crypto）、候选权重由 agent 自定（claude 路径同样如此）、服从性靠 prompt 约束；服务端额外多一层申报不一致（mismatch）诊断信号。池在回合内跨重试固定（防故意失败刷点）；消耗严格按 R1,R2,… 顺序核对（防挑号）。
- **qwen 工具调用可靠性装甲**：实测 1/6 概率"口述不写盘"（输出文件缺失），PiRunner 自动重试一次（`PI_MAX_ATTEMPTS`，默认 2）。
- **二轮优化（2026-08-22 token 分解实测驱动；回合为解码瓶颈，call#1 输出 ~5k token 中 ~65% 是 qwen 隐式思考）**：
  - **网关跨请求前缀缓存实测有效**（同前缀下一请求 cacheRead ~8.4k token；早前"跨请求不缓存"的结论有误）。user prompt 注入顺序按变化频率升序重排：rules → adjustments → tendencies → player → world → actors → history → 输入 → 随机池——history 原本置首，每回合轮转一行即打穿其后全部缓存。
  - **早退看门狗**：三产物落盘且形状合法（output 首行契约 + interaction 可解析）即 SIGTERM pi，跳过第二次 LLM 往返（实测该趟仅输出"回合完成"23 token，却要 4.3k fresh prefill + 整套网关往返）。新鲜度以 attempt 前 mtime 基线判定（fs 对 fs 比较——WSL2 下 mtime 滞后 Date.now() 数毫秒，墙钟比较会误杀）；SIGTERM 的非 0 退出码由 fired 标记豁免，撕裂写走既有重试自愈。`PI_EARLY_EXIT=0` 可关。
  - **`--tools write` 工具面收窄**：读/bash/edit 从模型工具列表移除，prompt 措辞约束升级为结构性不存在。
  - **角色卡预算**（`PI_ACTOR_BUDGET_BYTES`，默认 6KB）：超预算卡在 prompt 注入 REPLACE 修剪指令（合并重复、删过时证据，保 Emotional Core / Relationship State）——实测 actors 第 3 回合即可达 ~19.6KB，长局 prefill 漂移是回合时延劣化主因。服务端只发指令不硬截断，故事真相取舍留给模型。
  - **qwen 思考档位实测不可用**：`--thinking low` 直接诱发"口述不写盘"（与 `:off` 同病），`minimal` 被网关无视（输出 token 不降反升）——与 budget_tokens / no_think 一致，此路不通；解码成本中思考占比不可控是 pi+qwen+该网关组合的结构地板。
- **三轮优化（2026-08-23 全链路时间解剖驱动：init 248s / turn 102s 各做了一次逐事件实测拆解）**：
  - **时间地图结论**：turn 的用户可见内容（叙事+选项）在组合流的 86% 处就绪，其后 12% 是用户永远不读的 state-update 记账；init 的开场视窗在 79% 处才落盘、done.json 之后还有 20% 纯自查返工、开头 3% 是骨架探索往返。优化目标从"压缩服务器忙碌时间"转向"把可延迟的藏进用户阅读窗口、把结构性浪费直接消灭"。
  - **叙事先行（P1）**：pi spawn 切 `--mode json`，事件流经 SpawnOpts.onStdoutLine 旁路（不影响 stdout 聚合）；`toolcall_end(write output.md)` 携带参数原文，先跑与权威路径同源的泄密守卫后经 turn-progress 注册表（挂 globalThis——Next 构建会把模块复制进多个路由包）+ `GET turn-preview` 轮询接口推给前端。实测叙事在全程 84% 处可读；回合失败/重试时前端撤回（attempt 单调令牌防御迟到的异步发布推翻撤回/形成僵尸预览）。早退看门狗保持 mtime 版不动，事件流纯旁路。
  - **init 三刀（P2）**：① 骨架占位文件预注入 prompt（Read×4+find+Glob 探索段实测 7s 归零，init 工具轮次 40→21）；② 概念文件批量落盘指令（效果有限——qwen 经 claude 通道单轮多 Write 不稳定，output+interaction 双写可见，概念文件仍偏单写）；③ done.json 契约改为永远最后一步 + 看门狗落盘即杀（`CLAUDE_EARLY_EXIT`，mtime 基线防旧文件误杀，杀后非零退出码放行，orchestrator 校验链兜底）——post-done 尾巴实测 50s→~0。整体 init 248s→173s（同网关对照 183s）。
  - **感知层（P3）**：乐观回显（提交即显示"你"的输入）+ 等待期预打字排队（输入框解禁，上一回合落定自动发送，把玩家 think/打字时间藏进生成时间；清空时机固定在提交瞬间，失败回填仅输入框为空时——不吞 pending 期间的新草稿）+ 打字机渐显（预览叙事逐字浮现，点击跳过）。
  - **E2E 实测暴露并修复的生产级隐患**：(a) 旧产物蒙混提交——口述失效模式（pi 退出码 0 不写盘）下 turn/ 残留上一回合产物，无新鲜度校验会把旧 output 一字不差重复提交（实测复现），成功路径加 mtime 基线新鲜度门 + 旧 state-update 不重放；(b) json 事件流每行携带累积 partial，stdout 无上限累积撑爆 V8 字符串上限炸掉 data 回调——改 64KB 尾部环形缓冲 + 旁路 try/catch；(c) turn-progress 模块被 Next 构建分裂成两份 Map——挂 globalThis。
- **权限治理换轨**（见 claude-code-runner 注释）：claude CLI 2.1.140 + 网关环境下 settings 路径规则对 Write 调用完全不匹配，init 改 `--tools=Read,Write` + auto；orchestrator 新增受保护路径基线守卫（story.md / turn/input.md 与既有 history 守卫同级，fail-closed）。
- 模型锁定 qwen-fp8（项目约束）；pi 锁 0.73.1（Dockerfile）。
