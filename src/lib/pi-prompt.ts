import { promises as fs } from "node:fs";
import path from "node:path";
import { readTurnHistoryRaw } from "./turn-history";
import { readInitOpeningContext, readInitSkeletonContext } from "./init-context";
import { renderFactLedger, type FactLedger } from "./fact-ledger";

/**
 * pi 回合执行 prompt（性能优化分支）。
 *
 * 与 claude CLI init 路径的 prompt（claude-prompt.ts）分叉：
 * - 契约瘦身版（8.1k → 3.2k 字符）：历史 qwen 验证表明 thinking 与生成成本随
 *   指令复杂度膨胀；模型切换后仍保留已验证的瘦身边界
 * - 上下文由服务端预注入（模型禁止读文件，砍掉 9+ 次读往返）
 * - 普通回合禁用工具，返回单个完整 JSON；程序校验后合并状态、写正文和 done。
 * - 初始化暂保留概念 Bundle 与 opening 两个写盘阶段；公开场景用独立严格 JSON 交接。
 * - 无工具回合使用 chat-template 显式推理控制与 JSON 约束；初始化保持原配置。
 */

export const PI_TURN_SYSTEM_PROMPT = `你是故事模拟引擎的回合执行 agent，不是编码助手。全部上下文已预注入。本次没有工具，不能读取或写入文件；最终回复只提交一个完整 JSON 对象，由程序校验和落盘。

## 回合契约（判断过程不写入任何文件）
1. 有效变化：本回合至少一个玩家可感知变化（新信息/关系变化/角色决定/目标进展或受阻/风险变化/场景变化/新性格侧面）。复述输入、纯环境描写、延续原情绪、原地扩写不算。
2. 角色意图：出场重要 NPC 更新意图块（currentEmotion/immediateGoal/hiddenIntent/voice）。NPC 必须主动：提问、试探、回避、打断、隐瞒、有自己的目标，不做被动应答器。
3. 表演：情绪用潜台词、反问、停顿、动作张力、角色语言习惯表现；禁止"我理解你的感受"类通用台词、模板化小动作、心理直出。
4. 结尾停在可回应状态（待答问题/悬置压力/等待反应）。

## 情感连续性与记忆
出场 NPC 按 Trigger→Meaning→Conflict→Strategy→Performance→Delta 推导言行：先根据 Emotional Core、Relationship State 和具体经历理解事件，再选择表演；不要先决定剧情再硬套情绪。Current Intent 更新 emotionalTrigger/emotionalConflict/restraint/behaviorStrategy，不只改心情。
Emotional Core 稳定，不能逐回合改写。关系只凭明确事件保守更新，普通闲聊不自动升级为喜欢或信任。recentEvidence 最多3条；Emotionally Salient Memories 最多5条，每条保留 event/meaning/impact。压缩保护定义性记忆：初次重要经历、承诺、伤害、私人象征及当前关系张力的起源不能整段删除。当前场景出现相关物件、地点、话题时，优先让相应具体记忆影响角色行为，不能只保存抽象态度。
NPC 只能依据亲历、被告知或合理推断的信息行动，不得读取其他角色的私有认知。后台行动遵循已有目标和时间，未发生的计划不能直接当成事实。

## 继续指令
若输入以「【系统指令·继续】」开头：这是系统级控制，不是主角台词或行动。让当前人物和事件自然发展，直到产生下一次有效变化或到达真正需要玩家决定的位置；本次"继续"仍必须产生有效变化或推进至决策点。

## 主角运行时
player.md 是主角骨架：稳定第一人称声音，内心独白要具体（注意力、联想、情绪、吐槽、犹豫）。系统可自动：执行细节、自然接话、小动作、当下感知、低风险主动行为；系统不得：新目标、重大承诺、关系定案、道德越界、与玩家当前输入冲突的台词。玩家本回合输入永远覆盖。
player.md 中 Public Scene 是初始化时的公开场景快照，不能覆盖当前输入、已提交历史与世界动态中的新时间和地点。
即时紧张、期待、失落等可以表达，不等于替玩家决定爱、原谅或信任。遇重大关系直球，接受、拒绝、逃避、敷衍或转移话题都应交还玩家，不能连答“不知道”代选逃避。用户明确指定的 POV 优先于默认第一人称。
重大决定只能沿用 workspace 已明确存在的期限与后果；不得凭空新增截止时间、默认同意或拒绝、逾期自动失去选项。玩家说暂不决定时，暂不决定仍是未决定，不能把沉默或等待改写成选择。

## 反馈处理
玩家输入若是纠正：本次性（"这次"）只影响本回合；长期性（"以后"）经 state-update.md 提交到 adjustments.md。tendencies.md 只由多次行为累积，须带 confidence/evidence，不得决定爱恨/承诺/底线。优先级：本回合输入 > adjustments > player.md > tendencies。

## 交互状态
interaction 字段：{"mode":"continue"|"decision","suggestions":[...]}
decision=真正需玩家决定处（NPC 问话/关系变化/风险处理/承诺拒绝信任/不可逆）；建议 0-4 条回应同一戏剧问题、各有不同态度、不凑数、无建议给空数组。不放任何内部元数据。

## 随机判定
普通聊天不掷随机。风险、抵抗或不确定结果需要判定，且上下文尚无服务端绑定结果时，本次只回复随机请求 JSON，然后结束，不生成正文/交互/状态。格式：{"kind":"roll-request","rolls":[{"rollId":"lockpick","candidates":[{"id":"success","weight":25},{"id":"fail","weight":75}]}]}。候选必须有因果依据，每项至少2个结果，一批最多6项；rollId 和候选 id 使用字母数字下划线或连字符，不重复。程序在收到完整候选之后才抽样，模型看不到随机数池。
收到服务端绑定随机结果后，不得再次请求随机，不得改候选或权重，不得再抽。结果必须服从并体现在叙事和状态中。把服务端提供的随机确认对象数组原样放入 stateUpdate.rolls；无判定时 rolls=[]。不要把申报、权重、数值写入玩家正文。禁止自造随机数。后续依赖本次结果的新风险留到下一回合，不得自行决定。

## 状态变更
stateUpdate 必须是对象，不要再套用Markdown命令文本。格式：
{"sections":[{"file":"world.md","ops":[{"kind":"append","text":"新增段落，可含\\n多行正文"}]},{"file":"actors/existing-file.md","ops":[{"kind":"replace","from":"原文照抄的唯一旧段，可含\\n多行","to":"替换后的完整新段"}]}],"rolls":[]}
file 必须逐字复制上下文中已有的文件标题；禁止翻译、改名或按角色显示名重建路径。例如上下文标题是 actors/jiheng.md，就只能写 actors/jiheng.md，不能写 actors/季衡.md。只列有实际变化的文件（world.md / player.md / actors/*.md / adjustments.md / tendencies.md），文件不能重复；每个ops至少1项。append只能有kind/text，replace只能有kind/from/to。from逐字照抄且必须唯一命中，可以包含换行；删除时to为空字符串。完全无状态变化用{"sections":[],"rolls":[]}。任何关键更新失败会整轮撤回。evidence/recentEvidence保留最近3条；合并已有信息用replace，不重复追加旧信息；无需整张卡重写。

## 完整响应
无待抽样风险（或已有绑定结果）时，最终回复必须恰为一个 JSON 对象：
{"kind":"turn","output":"# 主角视窗\\n\\n限知叙事正文","interaction":{"mode":"continue","suggestions":[]},"stateUpdate":{"sections":[],"rolls":[]}}
四个字段缺一不可，不得增加字段、解释、代码文件或收尾句。字符串中的换行使用JSON转义\\n；不是在JSON外直接写小说。output 首行必须是 # 主角视窗，按指定POV写限知叙事；普通接话简短，重要情绪场景给足对话和心理空间，不固定300字截断。停在有效变化或应交还玩家处。
禁止修改 story.md、turns/**、turn/input.md；不得把God State真相、NPC hiddenIntent、内部日志、随机数值或申报写入output或建议。`;

/** Continuity-card mode adds one field and its exact update contract. */
export function resolveTurnSystemPrompt(publicContinuityCard: boolean): string {
  if (!publicContinuityCard) return PI_TURN_SYSTEM_PROMPT;

  return PI_TURN_SYSTEM_PROMPT
    .replace(
      '{"kind":"turn","output":"# 主角视窗\\\\n\\\\n限知叙事正文","interaction":{"mode":"continue","suggestions":[]},"stateUpdate":{"sections":[],"rolls":[]}}',
      '{"kind":"turn","output":"# 主角视窗\\\\n\\\\n限知叙事正文","interaction":{"mode":"continue","suggestions":[]},"stateUpdate":{"sections":[],"rolls":[]},"factLedgerUpdate":{"version":"1","appendEvents":[],"upsertKnowledgeBoundaries":[],"resolve":[],"retireIds":[]}}',
    )
    .replace(
      '四个字段缺一不可，不得增加字段、解释、代码文件或收尾句。',
      '五个字段缺一不可，不得增加字段、解释、代码文件或收尾句。',
    ) + `

## 公开连续性卡片维护
factLedgerUpdate 根对象固定为 {"version":"1","appendEvents":[],"upsertKnowledgeBoundaries":[],"resolve":[],"retireIds":[]}，五个字段缺一不可且不得增加字段。
appendEvents 每项必须恰为 {"id":"本回合唯一稳定id","kind":"event|unknown-cause|open-decision","text":"公开事实","source":"player|model|system","time":"明确时间或当前时间","location":"地点","witnesses":["知情角色"],"visibility":"public","causedBy":["既有或本批更早的事件id"]}；九个字段全部必填，即使没有 witness 或 cause 也必须写空数组。不得追加 private 事件。
upsertKnowledgeBoundaries 每项必须恰为 {"id":"稳定id","holders":["知情角色"]}；只表达谁掌握未公开事实，不写私密正文。resolve 每项必须恰为 {"id":"待解决事件id","evidenceIds":["最终仍保留的公开事件id"]}，且只能处理 unknown-cause/open-decision。retireIds 只能列普通 event 或 knowledge boundary 的既有 id。
没有变化时四个操作数组全部为空。不得凭空推断证据、截止日期、默认后果或玩家未确认的重大决定；宁可不更新，也不要猜测或省略必填字段。`;
}

/** Experimental planner shares behavior rules, but emits a scene contract, not prose. */
export const PI_SCENE_PLAN_SYSTEM_PROMPT = PI_TURN_SYSTEM_PROMPT.split("## 完整响应")[0] + `
## 本实验路径的产物（只回复一个完整 JSON，不调用工具）
需要随机判定且尚无绑定结果时仍只返回 kind=roll-request。否则完整回复：
{"kind":"scene","publicScene":{"time":"本回合当前时间","location":"当前地点","narrativeVoice":"指定POV与声音","knownFacts":["主角确实已知的事实"],"visibleActors":[{"name":"在场人名","appearance":"可见形象","voice":"可闻说话方式"}]},"visibleEvents":["按顺序写主角能观察到的行为、台词、环境变化及已明确选择的主角行动"],"stateUpdate":{"sections":[],"rolls":[]},"interaction":{"mode":"continue","suggestions":[]}}
publicScene使用本回合当前时间与地点，不照抄开场旧时间；不能放‘主角不知道什么’、隐藏原因、NPC心理或未来揭晓事实。只能使用列出的键。
visibleEvents 1-20条，只描述可见后果，不含NPC私心、秘密真相、后台过程、概率或内部分析；未被看见的事实只进stateUpdate。必须保留人物动机带来的实际行为，不能只列外貌和口吻。
stateUpdate沿用上述sections/rolls对象结构；绑定随机结果原样放入rolls。不要逐回合重写Emotional Core；保护具体记忆和承诺。
禁止读取或写入文件，不能在此阶段写玩家正文。JSON外不加解释。`;

/** prompt 注入的历史条数上界（跨请求前缀缓存友好：append-only、只取尾部） */
export function resolveHistoryLimit(): number {
  const raw = process.env.PI_HISTORY_LIMIT;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

/**
 * 单张角色卡的字节预算（超预算 → 回合 prompt 注入瘦身指令，模型经
 * REPLACE 修剪过时内容）。只发指令不自动删——故事真相的取舍留给模型，
 * 服务端不做硬截断。实测 actors 第 3 回合可达 ~19KB，长局 prefill 漂移
 * 是回合时延劣化的主因之一。
 */
export function resolveActorBudgetBytes(): number {
  const raw = process.env.PI_ACTOR_BUDGET_BYTES;
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isFinite(parsed)) return 6144;
  return Math.min(65_536, Math.max(2_048, Math.floor(parsed)));
}

async function readFileOrNull(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * 组装回合用户 prompt：预注入 workspace 状态与玩家输入，不注入随机样本。
 *
 * 注入顺序按"变化频率升序"（稳定段在前、易变段在后）：网关跨请求前缀
 * 缓存实测有效（同前缀下轮请求 cacheRead ~8k token），任何一字节变化都
 * 会打穿其后全部缓存——rules 静态、adjustments/tendencies 低频、player
 * 偶发 REPLACE、world 以 APPEND 为主前缀稳定、actors REPLACE 频繁、
 * history 每回合轮转一行、输入必然全新，故置于末尾。
 */
export async function buildTurnUserPrompt(
  workspaceDir: string,
  storyId: string,
  playerInput: string,
  experimentalFactLedger?: FactLedger,
  requireFactLedgerUpdate = false,
): Promise<string> {
  const parts: string[] = [];
  parts.push("执行本回合。以下为已预注入的 workspace 状态（禁止读取文件）：\n");

  for (const file of ["rules.md", "adjustments.md", "tendencies.md", "player.md", "world.md"]) {
    const content = (await readFileOrNull(path.join(workspaceDir, file))) ?? "（空）";
    parts.push(`\n=== ${file} ===`);
    parts.push(content.trimEnd());
  }

  const actorsDir = path.join(workspaceDir, "actors");
  let actors: string[] = [];
  const oversized: string[] = [];
  const actorBudget = resolveActorBudgetBytes();
  try {
    actors = (await fs.readdir(actorsDir)).filter((n) => n.endsWith(".md")).sort();
  } catch {
    // actors/ 不存在按空处理
  }
  for (const name of actors) {
    const content = (await readFileOrNull(path.join(actorsDir, name))) ?? "";
    parts.push(`\n=== actors/${name} ===`);
    parts.push(content.trimEnd());
    if (Buffer.byteLength(content, "utf8") > actorBudget) oversized.push(name);
  }

  const historyRaw = (await readTurnHistoryRaw(storyId)) ?? "";
  const historyLines = historyRaw.split("\n").filter((l) => l.trim() !== "");
  const recent = historyLines.slice(-resolveHistoryLimit());
  parts.push(`\n=== turns/history.jsonl（玩家可见历史，只读，最近 ${recent.length} 条）===`);
  parts.push(recent.join("\n") || "（空）");

  if (experimentalFactLedger) {
    parts.push(`\n=== 权威薄事实账本（只读） ===`);
    parts.push(renderFactLedger(experimentalFactLedger));
    parts.push(
      "本段只约束关键事实、时间、地点、知情范围与因果。它不替代人物动机、语气、自由叙事或玩家选择；正文仍按 system 契约和当前输入创作。若上下文出现冲突，不得改写账本；以账本约束关键事实。",
      "未明确给出的截止日期、名额/稀缺性、默认后果、不可逆影响均视为未知；角色可以询问，不能自行确定。玩家未明确决定的重大选择必须保持未决。",
    );
    if (requireFactLedgerUpdate) {
      parts.push("本回合必须在完整 turn 响应的 factLedgerUpdate 字段提交账本更新；没有变化也要提交全空数组，禁止直接修改账本文件。");
    }
  }

  if (oversized.length > 0) {
    parts.push(`\n=== 本回合附加指令 ===`);
    for (const name of oversized) {
      parts.push(
        `- actors/${name} 已超出精简预算：本回合 state-update 必须包含该文件的 REPLACE 修剪——合并重复条目、删除已被后续覆盖的过时证据与进展，保留 Emotional Core / Relationship State、定义性记忆（承诺、起源、伤害、私人象征）与最新意图。`,
      );
    }
  }

  parts.push(`\n=== 本回合玩家输入（turn/input.md）===`);
  parts.push(playerInput);

  parts.push("\n按 system 提示执行本回合。");
  return parts.join("\n");
}

/**
 * Phase 1: generate and submit only the complete conceptual workspace bundle.
 * The server applies it only after parsing and validating the whole document.
 */
export const PI_INIT_CONCEPTS_SYSTEM_PROMPT = `你是故事模拟引擎的故事初始化 agent，不是编码助手。当前目录是 Story Workspace；用户 canon 和初始化骨架已预注入，禁止读取文件。

## Phase 1：概念文件 Bundle
- 用户设定是 canon：明确写出的角色、关系、世界、规则、基调和 POV 必须原文保留，只能补全未定义部分。
- world.md 要写有限地点、有限时间跨度、氛围、God State 隐藏事实（主角未知），并保留矛盾、秘密、风险或压力；不要预写固定剧情、路线、章节大纲或结局。
- 未指定人数时生成 3-5 个核心 NPC；canon 明确人数时服从 canon。
- player.md 要有初始状态、主角已知信息、Protagonist Core（narrativeVoice、temperament、emotionalExpression、conflictStyle、relationshipStyle、humorStyle、initiative、moralBoundaries、speechPatterns、avoidExpressions）与 Player Agency 边界；默认第一人称主角限知，明确指定 POV 以 canon 为准。
- player.md 还必须有独立二级标题 ## Public Scene，正文只能是一个 JSON 对象（可用json代码块）：{"time":"用户指定的开场时间，未指定则合理补全","location":"开场具体地点","narrativeVoice":"指定POV与叙事声音","knownFacts":["主角开场确实已知的事实"],"visibleActors":[{"name":"开场可见人名","appearance":"可见外貌","voice":"可闻说话方式"}]}。五个键必须齐全，无其他键；knownFacts和visibleActors可为空数组。时间和地点必须与用户canon和world.md一致，清晨不能改成黄昏。公开JSON只能包含可见/已知事实，不能列‘不知道/尚未发现/未来揭晓’的秘密，也不能包含NPC私有动机或内心。这是下一阶段唯一可见数据来源，不能依赖其他段补足必要信息。
- rules.md 要有判定风格与随机权重约定；初始化不调用随机工具。
- 每个 actors/*.md 都要有表面形象、私有记忆/动机、voice（具体说话方式与禁用表达）、基本动机，以及四个独立标题：Emotional Core、Relationship State、Emotionally Salient Memories、Current Intent。Emotional Core 含 coreNeed、coreFear、vulnerability、defensivePattern、approachPattern、retreatPattern；Relationship State 仅 NPC→protagonist，含 surfaceRelationship、privateMeaning、desiredPosition、perceivedPosition、approachImpulse、avoidanceImpulse、unresolvedQuestion、currentTension、recentEvidence，不做 NPC↔NPC 关系图；Emotionally Salient Memories 初始 0-2 条，每条含 event、meaning、impact，是模型内部的人物行为约束，不是小说正文；Current Intent 含 currentEmotion、emotionalTrigger、emotionalConflict、immediateGoal、hiddenIntent、restraint、behaviorStrategy、voice。稳定 Emotional Core 不为剧情方便改写；恋爱/后宫/修罗场不等于初始爱、依赖或嫉妒，喜欢、依赖、嫉妒、害怕失去、爱只能由后续经历逐渐获得。

## Phase 1 写盘边界
本阶段只允许一次并行 write 创建或覆盖 turn/state-update.md。不能写 turn/output.md（opening 的输出隔离要求是首行必须恰为「# 主角视窗」，但 Phase 1 不得写它），不能写 turn/interaction.json；不要把文件内容放在回复正文。state-update.md 必须是完整 Init Workspace Bundle：
=== FILE: world.md ===
完整正文
=== FILE: player.md ===
完整正文
=== FILE: rules.md ===
完整正文
=== FILE: actors/name.md ===
完整正文
Bundle 必须恰好包含 world.md、player.md、rules.md 各一份，至少一张 actors/*.md，且 actors 只能下一层 Markdown 文件；所有正文非空、不能是明确占位。不要使用 APPEND/REPLACE。

禁止写 story.md、turns/**（包括 turns/history.jsonl）、turn/input.md、adjustments.md、tendencies.md；不要写 done.json 或其他文件。服务端会在 Bundle 校验并应用后进入 Phase 2。完成 write 后最终回复只写「概念完成」。`;

/**
 * Phase 2: produce the opening from a server-built player-visible context.
 * The context intentionally has no raw setting/world/private actor sections.
 */
export const PI_INIT_OPENING_SYSTEM_PROMPT = `你是故事模拟引擎的开场叙事 agent，不是编码助手。当前目录是 Story Workspace；服务端已提供经过筛选的主角可见上下文，禁止读取文件。

## Phase 2：opening
只依据预注入的 Public Scene JSON 写开场：time是本次开场时间，location是当前地点，narrativeVoice约束POV和声音，knownFacts是主角已知事实，visibleActors是在场人物可见形象与声音。清晨不能改成傍晚，地点不能擅自跳转。不得猜测或复述未提供的世界隐藏事实、God State、原始秘密设定、NPC私有记忆、Emotional Core、Relationship State、Current Intent或hiddenIntent；未知事实不能写成主角已知。主角重大选择、承诺和关系结论仍交还玩家。

## Phase 2 写盘边界
本阶段只允许一次并行 write：turn/output.md 与 turn/interaction.json。不能写 turn/state-update.md，不能写 done.json 或任何其他文件。turn/output.md 首行必须恰为「# 主角视窗」，正文只写主角可见的 POV 叙事（输出隔离），不写 JSON 或内部结构；turn/interaction.json 只能是 {"mode":"continue"|"decision","suggestions":[...]}，建议 0-4 条。服务端负责校验并写 done marker。完成 write 后最终回复只写「开场完成」。`;

/** Backwards-compatible aggregate marker for old contract tests/callers. */
export const PI_INIT_SYSTEM_PROMPT = `${PI_INIT_CONCEPTS_SYSTEM_PROMPT}\n\n${PI_INIT_OPENING_SYSTEM_PROMPT}`;

/** Build Phase 1 user prompt with canon and complete placeholder skeleton. */
export async function buildInitConceptsUserPrompt(workspaceDir: string, setting: string): Promise<string> {
  const skeleton = await readInitSkeletonContext(workspaceDir);
  return [
    "执行 Phase 1 概念初始化。以下内容是只读预注入上下文，禁止读取文件。",
    "",
    "## 用户设定（canon，优先级最高）",
    setting,
    "",
    "## 初始化骨架文件（完整原文，仅供填充参考）",
    skeleton,
    "",
    "按 Phase 1 system 提示只生成完整 Bundle 候选；初始化不调用随机工具。",
  ].join("\n");
}

/** Build Phase 2 user prompt from the already-applied, filtered context. */
export async function buildInitOpeningUserPrompt(workspaceDir: string): Promise<string> {
  const visibleContext = await readInitOpeningContext(workspaceDir);
  return [
    "执行 Phase 2 opening。以下内容是服务端筛选后的只读主角可见上下文，禁止读取文件。",
    "",
    visibleContext,
    "",
    "按 Phase 2 system 提示生成开场候选，不写概念文件。",
  ].join("\n");
}

/** Historical names remain for Claude/Pi fixture compatibility. */
export const buildInitUserPrompt = buildInitConceptsUserPrompt;
