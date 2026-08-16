# PRD: 小场景多角色异步故事模拟引擎

## Problem Statement

当前 AI 角色扮演/故事模拟大多是单线程、多角色共用上下文的聊天模式。用户虽然可以与 NPC 对话，但故事推进往往仍由用户显式控制，NPC 缺少真正的私有记忆、后台行动、错误认知和自主变化。

这导致几个核心问题：

1. 主角过于像导演，可以直接或间接控制剧情走向。
2. NPC 很容易变成同一个系统口吻，缺少独立人格和持续记忆。
3. 玩家能看到或影响不该知道的信息，主角视角不成立。
4. 故事倾向于被模型写成“合理、温和、配合玩家”的方向，缺少真实随机性。
5. NPC 之间的关系、误解、隐藏行动和后台事件无法自然发展。
6. 玩家输入经常被直接当成事实，而不是主角的行动意图或推理假设。
7. 系统缺少失败、误会、错过机会、关系恶化和不可逆后果，导致世界不像真实运行。

用户希望获得一种小规模、主角视角受限、多角色异步推进的故事模拟体验：用户只扮演主角，系统负责推进世界、调度 NPC、维护隐藏事实和私有记忆，并通过真随机让故事出现非惯性发展。

## Solution

构建一个小场景多角色异步故事模拟引擎。MVP 聚焦小规模封闭或半封闭故事，不做开放世界和大规模 NPC 小镇模拟。

系统核心体验：

用户只扮演主角。用户可以决定主角想说什么、想做什么、如何推理、如何试探，但不能直接决定行动是否成功、NPC 如何反应、隐藏真相是什么、后台事件如何发生。

系统维护一个全知世界状态，但主角不能直接读取全知状态。主角只能通过主角视窗看到自己能看到、听到、被告知或推理出的信息。NPC 也有各自的私有记忆、认知、误解、关系和行动倾向。

故事由主流程控制器推进。主流程控制器负责调度当前场景、判断玩家输入、维护世界状态、调用角色代理、进行可见性过滤、写入日志，并在需要时调用真实随机工具做判定。

NPC 的台词、动作、语气和现场表现由对应角色代理生成，而不是由主流程控制器统一代写。主流程控制器只做导演、裁判、状态管理和安全过滤。

随机判定必须使用工具或程序产生的真随机，不能让模型“假装随机”。随机结果需要写入内部判定日志。系统不能为了照顾主角而强行限制负面结果。只要符合因果、角色认知、世界状态和随机判定，系统可以产生失败、误会、错过机会、关系恶化、NPC 背叛、NPC 离开、线索丢失和不可逆后果。

### Target Narrative Experience

rpg4pov 的目标体验进一步明确为偏 galgame、同人游戏和视觉小说式的小场景故事体验，而不是普通环境描写器、通用 AI 小说生成器或多角色群聊 UI。

系统仍然保留小场景、多角色、主角视角受限、NPC 私有记忆、后台行动、真随机和失败后果等模拟基础；但玩家可见体验的核心应当是人物关系、角色对话、人物塑造、主角内心独白和情绪代入。

玩家仍然可以自由输入，系统不采用固定选项树。玩家不需要逐字控制主角的每一个动作和日常台词，但必须掌握关键方向、重大决定和关系选择。系统负责让主角成为一个生动、连贯、有声音的人；玩家负责决定主角最终成为怎样的人。

玩家可见叙事默认采用第一人称、主角限知视角、较充分的内心独白和视觉小说式的对话/心理/场景呈现。输出应像角色驱动的视觉小说，而不是流水账、泛环境描写或缺少人物意图的 AI 小说段落。

NPC 和世界不能只是被动响应玩家动作。重要 NPC 应当有自己的即时目标、情绪、隐藏意图和说话方式；他们可以主动提问、试探、回避、打断、撒谎、靠近、离开、暴露脆弱或采取与玩家目标不同的行动。

### Minimal Dynamic Narrative Principle

当前不采用预写完整剧本、固定章节大纲、固定角色路线、固定结局或预先锁定具体事件顺序。但系统也不能完全逐回合贪心生成。

本阶段采用最小动态原则：

> 不预写未来剧情，但每个回合必须实时判断：这一回合为什么值得发生，以及结束后什么发生了变化。

每个正常回合结束后，至少产生一个玩家能够感知的 Meaningful Change。变化可以很小，但必须让人物关系、角色理解、信息、风险、目标、场景、冲突阶段或情绪位置发生可感知移动。慢节奏、暧昧、闲聊和日常场景可以存在，但慢不等于不推进。

本阶段明确不立即引入完整 Director 系统、复杂 Beat 状态机、多 Agent 拆分、多候选剧情打分、长期剧情预测或完整事件队列；只有在最小动态方案实测不足后再单独设计。

### MVP Scope

MVP 只支持小场景故事：

- 1 个主角
- 3 到 5 个核心 NPC
- 少量临时角色
- 有限地点
- 有限时间跨度
- 若干隐藏事实、误解、关系变化或后台行动
- 用户输入的前提就是小场景；短期不处理大世界观自动收缩

MVP 正式体验为纯主角模式：

- 用户不能查看 God State
- 用户不能查看 NPC 私有记忆
- 用户不能查看后台事件真相
- 用户不能查看随机判定日志
- 用户不能直接修改 NPC 状态
- 用户只能通过主角的观察、对话、行动和推理影响世界

### Requirement Levels

#### P0 / MVP

P0 是第一版必须具备的能力，否则核心体验不成立。

1. 小场景故事运行。
2. 纯主角模式。
3. God State 与主角视窗隔离。
4. Player Knowledge Log。
5. Player-visible Turn History（玩家可见的已提交回合历史）。
6. NPC 私有记忆。
7. 用户输入拆分为行动意图、主角台词、玩家推理假设。
8. 玩家控制主角意图，系统控制世界结果。
9. 冲突、风险、不确定、高后果动作需要判定。
10. NPC 现场台词和动作由角色代理生成。
11. 主流程控制器负责调度、判定、过滤、落库和日志。
12. 工具真随机。
13. 随机判定日志。
14. 后台事件以摘要方式生成，不完整模拟 NPC 私下长对话。
15. 允许失败、误会、错过机会、关系恶化和不可逆后果。
16. 基础 NPC 关系与认知记录。
17. 临时角色可以自然出现，并写入内部日志。
18. 临时角色在剧情中变重要后可以升级为正式 NPC。
19. 系统生成角色不主动提示用户，只在故事中自然出现。
20. 系统生成角色必须有知识边界，不能直接替主角解开主线问题。
21. 用户只能输入角色卡设定，不直接查看或调整内部数值。
22. 玩家可见叙事默认采用第一人称、主角限知和较充分的内心独白。
23. 主角具有 Adaptive Authored Protagonist 模型：预设人格、稳定叙述声音、常规行为方式和可被玩家长期修正的边界。
24. 故事初始化必须提供 Protagonist Core、第一人称叙述基调、心理描写偏好和基础 agency boundaries。
25. 重要 NPC 初始化必须包含 voice、基本动机和支撑冲突/秘密/压力源的材料。
26. 正常 Story Turn 必须产生至少一个玩家可感知的 Meaningful Change。
27. 重要 NPC 在回合中不能只被动回答；其台词与行动应服务于当前情绪、即时目标、隐藏意图和独立 voice。
28. 玩家可见输出应优先通过潜台词、行动选择、打断、回避、反问和具体行为呈现情绪。
29. 系统可以自动演出符合主角人格的心理活动、低风险台词和自然反应。
30. 系统不得替玩家作出重大关系、道德、承诺、原谅、信任、背叛或不可逆决定。
31. 玩家本回合明确输入优先于基础人格、确认修正和历史推测。
32. 显式长期修正高于基础人格和系统推测。
33. 多次行为形成的推测倾向必须保留证据和置信度，不能由单次行为升级为稳定人格。
34. 当事件尚未到达真正决策点时，系统可以进入 Continuous Performance，而不是每段文字后强制玩家输入。
35. Decision Point 只在关键控制权应交还玩家时出现，并应停在明确可回应状态。
36. Suggestion Gate 只服务 Decision Point，建议数量允许为 0 到 4 个，始终保留自由输入。

#### P1 / Post-MVP

P1 是第二阶段增强真实感和可玩性的能力。

1. 更完整的 NPC 关系图。
2. NPC 之间的有方向、不对称关系。
3. NPC 对其他 NPC 的错误认知。
4. NPC 对主角的动态画像。
5. NPC 意图阶段模型：Thought → Plan → Commitment → Action。
6. Pending Intent，而不是未来事件直接确定。
7. 后台关键事件调用相关角色代理做决策，但不完整模拟对话。
8. 群戏发言权调度：谁说话、谁插话、谁沉默、谁只做动作。
9. 角色能力轻度拆分，例如观察、推理、识人、欺骗、战略、应变、自省、专业技能。
10. 玩家推理与 NPC 反应之间的长期反馈。
11. 角色基于自己的 Actor Knowledge 行动，而不是基于 God State 真相行动。
12. 角色是否意识到自己认知错误，由能力、性格、线索和随机判定决定。
13. 角色创建时，系统从自然语言角色卡推断内部模型。
14. 运行中根据角色行为和事件反馈逐渐完善角色画像。
15. 临时角色升级时进行轻量回填，只补当前剧情必要背景。
16. 系统生成角色可以与核心角色发展出重大关系，但需经过伏笔、证据链、概率判定和一致性检查。
17. 后台可以生成“潜在重大关系”作为软事实种子，但不直接固化为硬事实。

#### P2 / Future

P2 是高级模拟能力，暂不作为近期目标。

1. 大规模 NPC 小镇模拟。
2. 多地点长时间开放世界。
3. 大量 NPC 的全量关系网络。
4. 高级剧情节奏控制器。
5. 高级一致性检查器。
6. 多角色后台完整对话模拟。
7. 复杂能力数值体系。
8. 高度数值化 TRPG 风格规则。
9. 用户可切换作者模式或调试模式。
10. 开放世界观自动收缩为局部故事。
11. 复杂数据库化查询、回放和可视化工具。
12. 用户可查看或编辑内部状态的 GM 工具链。

## User Stories

1. As a player, I want to play only as the protagonist, so that I can experience the story from a limited subjective viewpoint.
2. As a player, I want the story to continue without me acting as the director, so that the world feels independent of my control.
3. As a player, I want NPCs to have private memories, so that they can remember things my protagonist does not know.
4. As a player, I want NPCs to act based on their own knowledge and misunderstandings, so that they do not behave as if they have omniscient knowledge.
5. As a player, I want hidden facts to stay hidden until my protagonist discovers them, so that investigation and uncertainty are meaningful.
6. As a player, I want the system to distinguish what the world knows from what my protagonist knows, so that hidden information does not leak into my perspective.
7. As a player, I want to hear NPC dialogue generated from each NPC’s personality, so that characters do not all sound like the same narrator.
8. As a player, I want NPCs to have their own tone, speech, actions and emotional reactions, so that character identity remains stable.
9. As a player, I want NPCs to sometimes lie, evade, hesitate or mislead me, so that conversations feel like social interaction instead of exposition.
10. As a player, I want NPCs to remember what I said to them, so that my words have consequences.
11. As a player, I want NPCs to form opinions about my protagonist, so that they can become more trusting, suspicious, afraid or hostile over time.
12. As a player, I want NPCs to interpret my questions and behavior, so that asking the wrong thing can reveal my suspicions or intentions.
13. As a player, I want my internal reasoning to be treated as a hypothesis, so that my guesses do not automatically become true.
14. As a player, I want my spoken accusations to affect NPC behavior, so that saying a theory out loud has different consequences from merely thinking it.
15. As a player, I want the system to separate my action, dialogue and inference, so that the world does not treat everything I type as objective fact.
16. As a player, I want ordinary low-risk actions to proceed naturally, so that the story does not stop for unnecessary checks.
17. As a player, I want risky, contested or high-impact actions to be judged by the system, so that I cannot simply declare success.
18. As a player, I want to control my protagonist’s intent, so that I still feel agency.
19. As a player, I want the system to control whether my protagonist succeeds, so that the world has resistance.
20. As a player, I want NPCs to resist, interrupt, misunderstand or refuse me when appropriate, so that the story feels alive.
21. As a player, I want true randomness to affect important outcomes, so that the story does not always follow the model’s narrative bias.
22. As a player, I want random outcomes to be able to produce inconvenient or negative results, so that the world does not protect me from failure.
23. As a player, I want failure to be possible, so that success feels meaningful.
24. As a player, I want missed opportunities to be possible, so that time and choices matter.
25. As a player, I want irreversible consequences to be possible, so that the story feels consequential.
26. As a player, I want NPCs to take background actions when I am not present, so that the world does not freeze outside my view.
27. As a player, I want background events to affect future NPC memory and behavior, so that off-screen developments matter.
28. As a player, I want off-screen events to be summarized rather than fully acted out, so that the system remains efficient while still simulating change.
29. As a player, I want to discover only the visible consequences of background events, so that I feel like a character inside the story rather than an omniscient observer.
30. As a player, I want NPCs to have relationships with each other, so that alliances, fear, resentment, dependency and betrayal can emerge.
31. As a player, I want NPC relationships to be asymmetric, so that A’s view of B can differ from B’s view of A.
32. As a player, I want NPCs to be wrong about each other, so that misunderstanding can drive the story.
33. As a player, I want smart NPCs to sometimes make mistakes, so that they do not feel like they have authorial protection.
34. As a player, I want foolish or impulsive NPCs to sometimes accidentally make good choices, so that the world is not deterministic.
35. As a player, I want important NPCs to have consistent personalities, so that they do not collapse into whatever the current scene needs.
36. As a player, I want role cards to define character canon, so that the system has stable constraints for character behavior.
37. As a player, I want the system to infer internal traits from role cards, so that I do not need to manually configure numbers.
38. As a player, I do not want to directly edit hidden NPC stats, so that I remain in the protagonist role rather than becoming a GM.
39. As a player, I want character behavior to evolve through events, so that NPCs can change without violating their original role cards.
40. As a player, I want major character changes to require sufficient pressure and story evidence, so that characters do not randomly break.
41. As a player, I want the system to add minor characters when the story naturally needs them, so that the world does not feel empty.
42. As a player, I do not want the system to announce newly created NPCs out of character, so that immersion is preserved.
43. As a system maintainer, I want system-created characters to be logged internally, so that character creation can be audited.
44. As a system maintainer, I want temporary characters to be upgradeable to formal NPCs, so that recurring or important characters gain memory and structure.
45. As a system maintainer, I want temporary character upgrades to preserve prior interactions, so that the upgrade does not feel like a retcon.
46. As a player, I want temporary characters to gain importance naturally, so that the story can grow beyond the initial cast.
47. As a system maintainer, I want upgraded NPCs to receive only necessary background, so that the system does not invent excessive lore.
48. As a player, I want system-generated NPCs to have knowledge boundaries, so that they do not reveal or solve the main mystery for me.
49. As a player, I want system-generated NPCs to be allowed to develop major relationships over time, so that the world is not locked to only the initial user-written roles.
50. As a system maintainer, I want major new relationships to require evidence, setup and consistency checks, so that the system does not randomly rewrite the story.
51. As a player, I want potential hidden relationships to exist as uncertain seeds, so that the story can develop surprising but grounded connections.
52. As a player, I want uncertain relationship seeds not to become hard truth too early, so that the story remains flexible.
53. As a player, I want my protagonist’s knowledge to distinguish observation, claims, inference and public knowledge, so that truth and belief remain separate.
54. As a player, I want NPC claims to be stored as claims rather than facts, so that lies and mistakes remain possible.
55. As a player, I want my own theories to be stored as hypotheses, so that I can use them later without making them true.
56. As a player, I want public knowledge to be available to my protagonist, so that the world has shared context.
57. As a player, I want direct observations to be reliable records of what my protagonist perceived, so that I can reason from them.
58. As a player, I want the system to treat suspicious observations carefully, so that “A looked nervous” does not automatically mean “A is guilty.”
59. As a player, I want NPCs to react differently to evidence-backed questions and baseless accusations, so that investigation quality matters.
60. As a player, I want NPCs to become more alert when I reveal sensitive suspicions, so that careless questioning has consequences.
61. As a player, I want the world to continue during waiting, resting or scene transitions, so that time has meaning.
62. As a player, I want the world not to fully advance after every small line of dialogue, so that conversations remain focused.
63. As a player, I want NPCs to have pending intentions rather than guaranteed future actions, so that future events remain uncertain.
64. As a player, I want an NPC’s thought not to equal action, so that hesitation, retreat and indecision can happen.
65. As a player, I want NPC intentions to move through thought, plan, commitment and action, so that decisions feel human.
66. As a player, I want NPCs to abandon plans when fear, pressure or external conditions change, so that they do not behave mechanically.
67. As a player, I want an NPC’s failure to act to still affect them, so that hesitation and cowardice have emotional consequences.
68. As a player, I want major NPC decisions to use character personality and random judgment, so that they are neither scripted nor arbitrary.
69. As a player, I want group scenes to avoid every NPC speaking every turn, so that dialogue feels natural.
70. As a player, I want some NPCs to only react silently, so that scenes can include tension without overcrowded dialogue.
71. As a player, I want to see my committed turn history after page refresh, so that I can continue the story without losing context.
72. As a player, I want each turn in history to show what I input and what the protagonist saw, so that I can review what happened.
73. As a system maintainer, I want turn history to be append-only, so that past turns cannot be retroactively modified.
74. As a system maintainer, I want the agent runner to read turn history for context but not modify it, so that history remains a stable record.
75. As a player, I want interruptions and silence to be possible, so that group dynamics feel organic.
76. As a player, I want the system to decide who has speaking priority in a scene, so that group conversations do not become mechanical turn-taking.
77. As a player, I want the selected NPC’s own agent to generate the actual words, so that speech stays character-specific.
78. As a player, I want the system to avoid exposing hidden thoughts in the visible narration, so that private intent remains private.
79. As a player, I want visible narration to include observable behavior and atmosphere, so that scenes are readable without leaking truth.
80. As a player, I want the protagonist view to be novel-like but limited, so that I get rich description without omniscience.
81. As a player, I want hidden NPC thoughts to affect future behavior, so that inner states matter even when I cannot see them.
82. As a system maintainer, I want NPC output to separate visible dialogue, visible action, private memory changes and hidden intent, so that visibility filtering is reliable.
83. As a system maintainer, I want the controller to validate NPC output, so that characters do not reveal information they should not know.
84. As a system maintainer, I want the controller to check role consistency, so that character agents do not violate their role cards.
85. As a system maintainer, I want random decisions to be logged, so that outcomes can be audited.
86. As a system maintainer, I want random outcomes to be binding, so that character agents cannot silently override them.
87. As a system maintainer, I want the controller to pass determined outcomes into character performance, so that agents perform the result instead of choosing it.
88. As a system maintainer, I want the system to distinguish hard facts, soft facts and rumors, so that uncertainty can be represented.
89. As a system maintainer, I want hard facts to be stable once established, so that the world remains consistent.
90. As a system maintainer, I want soft facts to support future development without immediately locking truth, so that stories remain flexible.
91. As a system maintainer, I want rumors and misunderstandings to belong to specific actors, so that belief does not equal truth.
92. As a system maintainer, I want NPCs to act from actor knowledge rather than god state, so that misinformation produces real consequences.
93. As a system maintainer, I want generated NPCs to be created only when narratively needed, so that the cast does not grow uncontrollably.
94. As a system maintainer, I want new characters to have importance levels, so that temporary, minor and core NPCs can be handled differently.
95. As a player, I want the system not to protect me from bad outcomes, so that the simulation feels honest.
96. As a player, I want negative outcomes to still have cause, so that the system does not feel unfair.
97. As a player, I want my choices to affect probability and consequences, so that agency exists even though I do not control outcomes.
98. As a player, I want role card settings to be the only explicit character setup I need, so that story creation stays lightweight.
99. As a player, I want to start from a small scenario, so that the system can focus on depth rather than scale.
100. As a player, I want themes to be unrestricted within the small-scene constraint, so that I can create different genres.
101. As a player, I want the system to not handle huge worlds in MVP, so that the first version remains focused.
102. As a system maintainer, I want MVP requirements to exclude author mode, so that the product does not split between player and GM workflows too early.
103. As a system maintainer, I want MVP requirements to exclude large-scale town simulation, so that token and complexity cost remain controlled.
104. As a system maintainer, I want the first version to validate the core loop, so that future complexity can be added safely.
105. As a player, I want the story to feel like a character-driven visual novel, so that relationships, dialogue and inner monologue carry the experience.
106. As a player, I want the protagonist to have a stable first-person narrative voice, so that I am not playing a blank camera.
107. As a player, I want the protagonist to have inner reactions and thoughts, so that the story has emotional immediacy.
108. As a player, I want the system to avoid deciding major relationship conclusions for me, so that I keep control of commitment, trust, forgiveness and rejection.
109. As a player, I want ordinary protagonist reactions to be performed naturally, so that I do not need to micromanage every greeting, pause or low-risk reply.
110. As a player, I want to correct the protagonist’s portrayal, so that future narration can better match how I want to play.
111. As a player, I want the system to distinguish one-time corrections from long-term preferences, so that a regeneration note does not permanently rewrite the protagonist.
112. As a player, I want every normal turn to change something I can perceive, so that the story does not stall in decorative description.
113. As a player, I want slow scenes to still move relationships or understanding, so that daily conversation can matter without needing constant plot twists.
114. As a player, I want NPCs to pursue their own immediate goals, so that they feel like people rather than response devices.
115. As a player, I want NPCs to evade, interrupt, lie, test me or change the topic when appropriate, so that conversations have social tension.
116. As a player, I want character emotion to be shown through subtext, timing and action, so that narration does not over-explain hidden psychology.
117. As a player, I want the system to continue performance when no real decision is needed, so that scenes do not stop after every small paragraph.
118. As a player, I want to interrupt a continuous performance with free input, so that I still have agency while the scene flows.
119. As a player, I want the system to stop at real decision points, so that important choices remain mine.
120. As a player, I want decision points to make the current dramatic question clear, so that I understand what I am deciding and why it matters.
121. As a player, I want suggestions only when they help with a real decision, so that options do not replace free input or create irrelevant branches.
122. As a player, I want suggestions to fill the input box rather than auto-submit, so that I can revise them before acting.
123. As a system maintainer, I want narrative turn outputs to preserve protagonist-view isolation, so that richer inner monologue does not leak NPC private intent.
124. As a system maintainer, I want new narrative quality checks to avoid fixed scripts, routes and endings, so that the system stays dynamically generated.

## Implementation Decisions

### Product-Level Decisions

1. The product is a small-scene multi-character asynchronous story simulation engine, not a generic group chat UI.
2. MVP is limited to a small story scope: one protagonist, three to five core NPCs, limited locations, limited timespan, small number of temporary characters, and a small number of hidden facts or relationships.
3. MVP assumes the user provides a small-scene premise. It will not attempt to automatically shrink large worldbuilding input into a small playable story.
4. The formal user experience is pure protagonist mode. Author mode, GM mode, debug mode and hidden-state inspection are out of scope for MVP.
5. User-provided character cards are treated as canon. The system may infer internal models from them but cannot casually rewrite them.
6. Users cannot directly see, tune or override internal NPC stats.
7. System-generated NPCs are allowed, but they should appear naturally in the story and be logged internally. The user should not receive out-of-character notifications that a character was created.
8. Temporary characters can be upgraded into formal NPCs when they become important through repeated interaction, possession of important information, participation in key events, relationship formation, or future reuse value.
9. Upgraded characters receive only lightweight background needed to explain current behavior and current story function. The system must not use upgrades to invent major unearned secrets or solve the main conflict.
10. System-generated characters may develop major relationships over time, but major relationships should emerge through soft facts, evidence, setup, probability checks and consistency validation rather than sudden arbitrary retcons.

### Narrative Experience Decisions

1. The target player-visible experience is closer to galgame, fan game and visual novel narration than generic prose generation.
2. Character relationships, dialogue, protagonist inner monologue, emotional identification and character shaping are first-class product goals.
3. Player-visible narration defaults to first person, protagonist-limited viewpoint and enough inner monologue to establish a recognizable protagonist voice.
4. The system should actively write attention shifts, memories triggered by current stimuli, immediate emotions, doubts, impulses, hesitation and protagonist-specific commentary.
5. Protagonist psychology should be concrete and voiced. Long-term reliance on vague phrases such as “a strange feeling” or “complicated emotions” is not acceptable.
6. NPC and world behavior should be active. Important NPCs can start conversations, ask questions, test the protagonist, evade, lie, interrupt, leave, approach, hide information or expose vulnerability.
7. Character emotion should be performed through subtext, timing, interruption, avoidance, concrete action, callbacks and tension between words and intent.
8. The system should avoid generic AI dialogue such as overly mature, polite, therapeutic or abstract relationship summaries when they do not match the character.
9. More text, prettier prose or more environmental detail does not count as better narration unless it changes information, relationship, risk, goal, scene state or character understanding.

### Meaningful Change Decisions

Every normal turn must produce at least one player-perceivable Meaningful Change. Valid changes include:

1. Gaining new information.
2. A relationship changing.
3. A character making a decision, commitment, refusal, lie or stance change.
4. Player goal progressing or being obstructed.
5. Risk escalating, being exposed, mitigated or resolved.
6. Time, place or scene changing.
7. A character revealing a new personality facet.
8. The player's understanding of a character changing.
9. A character forming a new goal or abandoning an old one.
10. The current conflict entering a new stage.

The following alone do not count as Meaningful Change:

1. Restating or expanding the player's input.
2. Adding pure environment description.
3. Adding parallel detail to the same object.
4. Continuing the same emotion without new behavior or relationship change.
5. Expressing the same information as the previous turn with more words.
6. A character maintaining their original attitude and waiting for the player to push.
7. Simply writing longer or more ornate text.
8. Repeating uninformative body, light, weather or atmospheric details for mood.

Slow scenes, idle conversation, ambiguous moments and quiet pacing are allowed, but they must advance at least one of: relationship, character understanding, emotional position, trust or misunderstanding, or conditions for future conflict. Slow does not mean stationary.

### Dynamic Narrative Decisions

1. The system does not prewrite the future plot.
2. The system does not use fixed chapter outlines, fixed character routes, fixed endings or pre-locked event sequences in the current phase.
3. The system must still avoid greedy turn-by-turn stagnation by deciding why the current turn matters before rendering it.
4. A normal turn must produce at least one player-perceivable Meaningful Change.
5. Meaningful Change can be new information, relationship movement, a character decision, goal progress or obstruction, risk change, time/place/scene change, new character facet, changed understanding, new/abandoned goal, or conflict-stage movement.
6. Repetition, restatement, parallel detail, decorative environment expansion, unchanged emotion, unchanged character attitude, or longer prose alone do not count as Meaningful Change.
7. Slow scenes are valid when they move relationship, trust, misunderstanding, emotional position, character understanding or future conflict conditions.
8. The current phase does not introduce a full Director system, complex Beat state machine, multi-agent split, multi-candidate plot generation and scoring, long-term plot prediction, full event queue or full foreshadowing manager.

### Protagonist and Agency Decisions

1. The protagonist model is Adaptive Authored Protagonist.
2. The protagonist has a preset personality, stable first-person narrative voice and ordinary behavior patterns.
3. The system may automatically generate in-character psychology, low-risk dialogue, natural reactions, execution details for explicitly chosen actions and light proactive behavior during long stalls.
4. The player controls key direction, major relationship choices, irreversible decisions and explicit current-turn input.
5. The system must not invent new player goals, major commitments, key relationship definitions, moral verdicts, irreversible actions or decisions that close important alternatives.
6. The system can fully describe emotional and cognitive process, but must not complete key psychological conclusions such as love, forgiveness, trust, betrayal, revenge or permanent rejection without player input or a real decision point.
7. Protagonist Core is created at story initialization and changes slowly.
8. Confirmed Adjustments come from explicit setup, direct long-term preference, correction or feedback and override the base protagonist and inferred tendencies.
9. Inferred Tendencies are gradual, evidence-bearing and confidence-bearing. They affect voice, low-risk reactions and routine interaction style, but do not decide major choices.
10. Priority order is: current player input, Confirmed Adjustments, Protagonist Core, high-confidence tendencies, low-confidence tendencies, system default.

### Protagonist Control Boundary Decisions

The system may automatically handle:

1. Execution details for actions the player has already committed to.
2. Natural replies that do not change the protagonist's stance.
3. Routine greetings and small talk.
4. Small gestures and habits consistent with the protagonist's personality.
5. Immediate perception and psychological activity.
6. Low-risk proactive behavior that does not close important choices.
7. Mild proactive advancement during long stalls, consistent with the protagonist's character.
8. Natural reactions reliably inferrable from the player's current input and established personality.
9. Transitional dialogue that does not constitute a major commitment.

The system must not autonomously add:

1. New goals the player has not expressed.
2. Major commitments.
3. Key relationship decisions.
4. Moral boundary violations.
5. Dialogue that contradicts the player's current input.
6. Decisions that close other important choices.
7. Relationship verdicts such as love, hatred, forgiveness or rupture.
8. Irreversible actions that clearly change the route.

The governing principle is:

> The system can complete how a player-chosen action happens, but must not decide a key direction the player has not chosen.

### Protagonist Core Example Directions

Protagonist Core should be specific enough to support recognizable first-person inner monologue. Example directions include:

- Calm and restrained, but not cold.
- More likely to show care through actions than sweet words.
- Observes first in conflict, then asks directly once the problem is clear.
- Occasionally self-deprecating, but never glib.
- Willing to break long silences.
- Does not make permanent commitments lightly.

These are illustrative, not prescriptive. Each story's Protagonist Core will differ.

### Explicit Feedback and Continuous Fitting Decisions

The system should support player correction mechanisms such as:

- "This doesn't feel like me."
- "The inner monologue is too cold."
- "The inner monologue is too much."
- "I wouldn't be this angry."
- "I don't like her."
- "Don't interpret care as love."
- "The tone should be more restrained."
- "Don't make this kind of commitment for me."
- "The protagonist can be more proactive."
- "Only regenerate this time; don't record this long-term."

The system must distinguish:

1. **One-time correction**: Only affects current generation. Does not change long-term protagonist model.
2. **Long-term preference**: Written into Confirmed Adjustments. Affects all future generation.

Explicit feedback must override system inference. The system may fit the player from historical behavior, but must not silently upgrade inference into confirmed personality.

### Story State Decisions

1. The system distinguishes God State from actor-specific knowledge.
2. God State contains the true world state, hard facts, hidden facts, event history and system-known state.
3. The protagonist cannot directly access God State.
4. NPCs cannot directly act from God State. They act from their own knowledge, memory, beliefs, misunderstandings and relationship models.
5. The system maintains a Player Knowledge Log.
6. Player Knowledge Log must distinguish at least four categories: direct observations, claims, inferences and public knowledge.
7. Player inferences are stored as hypotheses. They do not become hard facts.
8. NPC statements to the protagonist are stored as claims, not automatically as truth.
9. Facts are conceptually divided into hard facts, soft facts and rumors or misunderstandings.
10. Hard facts should be stable after being established.
11. Soft facts can represent potential hidden truths or future story seeds without immediately locking the world.
12. Rumors and misunderstandings belong to specific actors and can influence their behavior even if they are false.

### Player Input Decisions

1. Player input is not accepted as direct world fact.
2. Player input is parsed into action intent, protagonist dialogue and player inference or hypothesis.
3. The protagonist controls intent, speech and attempted action.
4. The system controls success, consequences, NPC reaction and world change.
5. Routine, low-risk actions can succeed without explicit judgment.
6. Contested, risky, uncertain or high-impact actions require system judgment.
7. Player attempts that involve another actor’s resistance, hidden facts, physical conflict, persuasion, deception, stealth or irreversible consequences require judgment.
8. If the player speaks a hypothesis aloud, NPCs who hear it may update their memory and model of the protagonist.
9. If the player only expresses internal reasoning, NPCs do not know it unless the protagonist acts on it or says it.

### NPC Decisions

1. NPCs have private memory.
2. NPCs have actor-specific knowledge and can hold wrong beliefs.
3. NPCs have relationship records toward the protagonist and toward other important NPCs.
4. NPC relationship records are directional and can be asymmetric.
5. NPC relationship records should include both relationship metrics and actor models.
6. Relationship metrics represent emotional or social dimensions such as trust, fear, suspicion, resentment, affection, dependence or control.
7. Actor models represent how one actor perceives another actor’s traits, weaknesses, secrets, intentions, knowledge or reliability.
8. NPCs should act based on their own knowledge and actor model, not the objective truth.
9. The system does not protect NPCs from acting on mistaken beliefs.
10. Whether an NPC recognizes a possible mistake depends on their abilities, personality, available clues and random judgment.
11. Character ability is not represented as one generic intelligence value. It should be lightly split into dimensions such as observation, reasoning, social reading, deception, strategy, adaptability, self-awareness and domain skills.
12. Exact internal ability values are hidden from the player.
13. The player may perceive qualitative character traits through interaction, not through numeric stat panels.
14. Character internal traits are inferred from role cards and refined through story events.
15. Character refinement must be slow, evidence-based and constrained by the role card canon.

### Character Agent Decisions

1. NPC dialogue, visible action, tone, emotional expression and scene performance are generated by the relevant character agent.
2. The controller does not act as the author of all NPC voices.
3. The controller acts as scene director, rule judge, state manager, visibility filter and logger.
4. Character agents are invoked on demand rather than treated as always-on permanent chat windows.
5. Character agents receive role card canon, relevant memory, current state, allowed knowledge, relationship context and controller-determined outcome constraints.
6. Character agent output should conceptually separate visible dialogue, visible action, private thought, hidden intent, memory deltas and state-change suggestions.
7. Only visible dialogue and visible action are rendered to the protagonist.
8. Private thought, hidden intent, state deltas and memory deltas are internal.
9. The controller validates character output for visibility leaks, knowledge violations and role inconsistency.
10. For protagonist-present scenes, character agents use performance mode.
11. For background key events, character agents may use decision mode.
12. Background key events do not require complete private dialogue simulation. They should call relevant character agents only for key decisions and then summarize the event.
13. MVP 中"角色代理"首先是逻辑角色视角、私有角色状态和独立决策边界，不要求每个 NPC 启动独立进程、独立模型调用或独立 Runner。当前允许一个 Runner 在一个 Story Turn 中读取多个角色的私有状态、分别模拟各角色的目标判断和行为，同时保持角色之间的记忆与信息隔离。不要误解为每个 NPC 必须调用一次 Claude、当前阶段必须实现多 Agent 并行、或 Issue 8 必须拆多个独立运行时。

### Controller Decisions

1. The controller coordinates player input parsing, scene context, NPC selection, random judgment, character agent calls, visibility filtering and state updates.
2. The controller must not let protagonist-visible output read from hidden facts directly.
3. The controller must filter NPC output before presenting it to the protagonist.
4. The controller must write internal logs for important decisions, random outcomes, generated characters and visibility-sensitive transformations.
5. The controller must support background event summaries.
6. The controller must support NPC updates after protagonist interactions.
7. The controller must support player knowledge updates after visible events.
8. The controller must support NPC memory updates after the protagonist says or does something in their presence.
9. The controller must support negative outcomes when justified by cause, state, actor knowledge and random judgment.

### Randomness Decisions

1. Randomness must come from a real tool or programmatic random source.
2. The model must not be trusted to “act random” by itself.
3. Random judgments are used to counter model bias toward safe, moral, narratively convenient or player-protective outcomes.
4. Random judgment uses a hybrid model: rule baseline, model-suggested contextual modifiers, controller-capped probability, tool roll and judgment log.
5. Character agents do not get to override final random results.
6. Random outcomes are binding inputs into character performance.
7. Random judgment logs are internal and not visible to the player in MVP.
8. Randomness should be weighted by character state, personality, relationship, pressure, environment and context rather than uniform probability.

### Time and Event Decisions

1. MVP uses a small-scale time model appropriate for limited scenes.
2. The world may advance during waiting, resting, travel, scene transitions or other meaningful time jumps.
3. The system should not necessarily advance the whole world after every individual line of dialogue.
4. Background events are summarized.
5. NPC future actions should be treated as pending intentions, not guaranteed future events.
6. Future actions may be represented by stages: thought, plan, commitment and action.
7. Stage changes should depend on character state, context and random judgment.
8. In MVP, the full staged intent model can be simplified, but the requirement remains that intended future actions are uncertain until resolved.

### First-Person and Inner Monologue Decisions

1. Player-visible narration defaults to first person, protagonist-limited viewpoint.
2. The system should actively write attention shifts, memories triggered by current stimuli, immediate emotions, doubts, impulses, hesitation and protagonist-specific commentary.
3. Protagonist psychology should be concrete and voiced. Long-term reliance on vague phrases such as "a strange feeling" or "complicated emotions" is not acceptable.
4. The system should write complete psychological processes: what the protagonist noticed, why a detail made them pause, what suspicion or expectation arose, and how they waver between interpretations.
5. The system may write partial psychological movements: "I wanted to ask her", "That line made me uncomfortable", "I'm starting to suspect it's not what she said", "The words reached my mouth, but stopped."
6. Whether to actually press the question, whether to believe, whether to forgive — these must be returned to the player at key moments.
7. The following content must in principle come from explicit player input or be returned to the player at a real decision point: falling in or out of love, forgiving or not forgiving, trusting or distrusting someone, confessing, committing, refusing, defining a relationship, reaching a moral verdict, taking revenge, betraying, or any other irreversible action.

The governing principle is:

> The system may fully describe the process of emotion and thought, but must not complete key psychological conclusions or major decisions for the player.

### Narrative Turn Contract Decisions

The current phase still allows one Runner/LLM invocation to complete one Story Turn, but the logical order must be preserved:

1. Understand player input and current story state.
2. Read protagonist core, confirmed adjustments and necessary inferred tendencies.
3. Determine at least one Meaningful Change for this turn.
4. Determine relevant NPC current emotion, immediate goal, hidden intent and voice.
5. Decide what active behavior the NPC will take.
6. Decide which protagonist reactions can be auto-performed and which decisions must be returned to the player.
7. Render the result as first-person, galgame/visual-novel-style player-visible output.
8. Determine whether the turn should enter Continuous Performance or stop at a Decision Point.
9. Update necessary world, character, relationship and protagonist tendency state.

Narrative Turn Contract 负责叙事质量，包括 Meaningful Change、Character Intent、NPC 主动行动、Performance、避免平级细化、第一人称叙事基础规则和正文结束在自然叙事边界。不包括正式的 `continue | decision` 数据结构、Suggestion Gate、UI 建议、"继续"命令、interaction state API 和持久化——这些由 Decision Points & Input Guidance 负责。

Internal turn metadata may include:

- This turn's Meaningful Change.
- NPC Character Intent.
- Allowed protagonist auto-performance.
- Whether the turn reached a Decision Point.

Internal NPC hidden intent and private state must not be rendered directly to the player. Existing protagonist-view isolation rules remain binding.

### NPC Character Intent Decisions

Important NPCs must not only passively answer the player or provide information. Before each turn, the system should consider relevant NPCs' minimal dynamic state:

1. `currentEmotion`: The NPC's primary emotion right now.
2. `immediateGoal`: What the NPC currently wants from the player, other characters or the current scene.
3. `hiddenIntent`: The NPC's real purpose, need, worry or probe that they will not directly state.
4. `voice`: How the NPC specifically speaks, including expression habits, directness level, avoidance patterns, humor style and forbidden generic expressions.

NPC dialogue and behavior should serve their own `immediateGoal`, not only:

- Answering the player's questions.
- Providing plot exposition.
- Complying with the player's requests.
- Waiting for the player to advance.

NPCs may proactively:

- Start conversations.
- Ask questions.
- Test or probe.
- Evade or deflect.
- Lie.
- Interrupt.
- Change the topic.
- Leave.
- Approach.
- Conceal information.
- Expose vulnerability.
- Take actions that differ from the player's goals.

### Performance and Presentation Decisions

1. After determining this turn's Meaningful Change and Character Intent, the system renders them into player-visible content.
2. Character emotion should be performed through subtext, counter-questions, evasion, interruption, pauses, answers that dodge the question, actions that create tension with dialogue, character-specific speech habits, active choices to do or not do something, callbacks to past details, gaps between words and real intent, and different understandings of the same event.
3. The system should avoid: directly explaining the NPC's full psychology, having all characters use similar mature/polite/rational expressions, generic AI dialogue such as "I understand your feelings" or "we should face this honestly", attaching template eye/lip/finger/breathing descriptions to every line, stacking uninformative environment and body descriptions for the sake of seeming detailed, long abstract summaries about relationships/trust/life, writing more or prettier text without actual change, and having all characters orbit the player without their own goals and stances.

### Performance Flow Decisions

1. The system should not force a new protagonist action after every small paragraph when the scene has not reached a real choice.
2. Continuous Performance means the current people and event continue naturally until another Meaningful Change occurs or a real Decision Point is reached.
3. During Continuous Performance, NPCs may continue dialogue or action, the protagonist may have inner monologue, and the system may generate low-risk natural reactions consistent with the protagonist.
4. The player can still interrupt Continuous Performance with free input.
5. “Continue” is a system-level control, not a protagonist line or story-world action.
6. Continuous Performance must not become meaningless infinite elaboration. Each continuation still needs Meaningful Change or movement toward a Decision Point.
7. A Decision Point appears when the next step involves a major relationship direction, risk handling, information disclosure, conflict escalation/de-escalation, commitment, refusal, trust, forgiveness, irreversible consequence or multiple reasonable directions the system should not choose for the player.
8. A Decision Point should stop in a clear respondable state and make the current dramatic question understandable.
9. A Decision Point should not stop at pure environment description, vague reflection, unpressured silence or a generic “what happens next” prompt.
10. Suggestions are an input aid for Decision Points, not a story propulsion mechanism.
11. Suggestion count can be 0, 2, 3 or 4. The system must not produce four options just to fill a fixed shape.
12. All suggestions should answer the same current dramatic question and represent distinct attitudes or handling strategies.
13. Suggestions should include at least one option that clearly advances the current conflict and at least one relatively neutral option when appropriate.
14. Suggestions should fit the current protagonist and should not open unrelated horizontal branches merely to simulate freedom.
15. Clicking a suggestion fills the input box only; it does not auto-submit and free input remains available.

### Interaction State Decisions

1. 叙事正文（`turn/output.md`）和交互状态（`turn/interaction.json`）是两个不同概念。叙事正文是故事内容；交互状态是当前回合的 continue/decision 模式和建议。
2. 交互状态属于受控的玩家可见输出，不能从 agent stdout、任意日志或内部状态直接拼装。
3. 交互状态应被 snapshot/rollback 覆盖。
4. 刷新页面后应能恢复当前 continue/decision 状态和建议。
5. 缺失、格式错误和不合法建议的处理方式应在 Issue 10 plan 中定义。
6. Issue 12 必须验证交互状态中不能泄漏 hiddenIntent、NPC 私密状态和内部推理。
7. 叙事正文仍只来自 `turn/output.md`，交互状态不改变此规则。

### Story History Entry Decisions

1. 玩家可见历史为带类型的结构，区分 opening（开场内容，无玩家输入）和 turn（正常回合，有玩家输入）。
2. 开场主角视窗必须进入完整的玩家可见历史。
3. 刷新页面后必须能够恢复并展示开场内容。
4. 不得伪造一条"开始故事"玩家输入。
5. Initializer 提交 opening entry，TurnOrchestrator 提交 turn entry。
6. committed history 的写入者应表述为"受信任的系统提交者"，而不是只限 TurnOrchestrator。
7. Runner / Claude 仍然不得直接修改 committed history。

### Group Scene Decisions

1. In group scenes, the controller decides who speaks, who interrupts, who remains silent and who only visibly reacts.
2. The controller should avoid making every NPC respond on every turn.
3. Speaking priority depends on relevance, personality, pressure, relationship, current topic and random judgment.
4. Once a speaking or reaction role is assigned, the relevant character agent generates the actual performance.

### Visibility Decisions

1. The protagonist view is limited but can be novel-like.
2. The system may describe visible behavior, atmosphere, tone and body language.
3. The system must not reveal hidden truth, private thoughts or hidden intent unless the protagonist has a valid way to know them.
4. The system should avoid presenting interpretation as certainty. For example, visible nervous behavior should not automatically be rendered as confirmed guilt.
5. Protagonist-visible narration should represent what the protagonist can see, hear, be told or reasonably infer.

## Testing Decisions

### Test Philosophy

Tests should focus on external behavior and contract-level outcomes, not implementation details. The most important test question is not “which internal method was called,” but whether the resulting story state, protagonist-visible output, NPC memory and logs obey the simulation rules.

Good tests should verify:

1. Hidden facts are not leaked into protagonist-visible output.
2. Player hypotheses do not become hard facts.
3. Player dialogue can affect NPC memory and relationship state.
4. Contested actions are treated as attempts, not automatic success.
5. Random outcomes are produced by the random service and become binding.
6. Character-visible output is filtered before reaching the protagonist.
7. NPCs act from their own knowledge, not from God State.
8. System-generated NPCs are logged internally and appear naturally in story text.
9. Temporary characters can be upgraded without inventing unearned major secrets.
10. Negative outcomes can occur when justified.
11. Normal turns produce player-perceivable Meaningful Change.
12. Important NPCs act from Character Intent rather than passive exposition.
13. Protagonist-visible output has a stable first-person voice without leaking NPC private state.
14. Protagonist auto-performance respects player agency boundaries.
15. Continuous Performance and Decision Points stop in the correct interaction state.

### Proposed Test Seams

These seams are expressed at the domain contract level so they remain valid while the runtime evolves.

1. Story Turn Processing Seam

Test a full user turn from player input to protagonist-visible response and state updates.

This is the highest-value MVP seam because it validates the core loop:

Player input → input parsing → judgment → NPC response → visibility filtering → state updates → protagonist output.

Expected coverage:

- Input is split into action, dialogue and hypothesis.
- Risky action does not auto-succeed.
- NPC output is generated only from allowed knowledge.
- Protagonist output omits hidden facts.
- Player Knowledge Log receives only visible observations, claims and hypotheses.

1. Visibility Projection Seam

Test God State and actor-specific knowledge projection into protagonist-visible output.

Expected coverage:

- Hard facts hidden from protagonist are not exposed.
- NPC private thoughts are not exposed.
- Visible actions are exposed.
- NPC claims are recorded as claims, not truth.
- Player observations are recorded as observations.

1. Character Agent Contract Seam

Test the contract between controller and character agent.

Expected coverage:

- Character agent receives constrained context.
- Character agent returns separated visible and private fields.
- Controller rejects or repairs output that includes forbidden knowledge.
- Character speech remains attributable to the selected character rather than the controller.

1. Random Judgment Seam

Test the random judgment service and its integration.

Expected coverage:

- A real random roll or injectable deterministic random source determines outcome.
- Probability inputs are logged.
- Outcome is logged.
- Character performance follows the outcome instead of re-deciding.
- Negative outcomes are allowed when rolled.

1. Player Knowledge Log Seam

Test protagonist knowledge updates.

Expected coverage:

- Direct observations are stored as observations.
- NPC statements are stored as claims.
- Player reasoning is stored as hypotheses.
- Public facts are available as public knowledge.
- No hidden God State fact is inserted into player knowledge without discovery.

1. Player-visible Turn History Seam

Test committed turn history persistence and retrieval.

Expected coverage:

- Each committed turn is appended to `turns/history.jsonl`.
- History entry contains turnId, timestamp, player input and protagonist-visible output.
- Page refresh can retrieve and display full history.
- Claude Code Runner cold-start can read history for context.
- Claude Code Runner cannot modify history file.
- History append failure causes turn failure and rollback.

1. NPC Memory and Actor Model Seam

Test NPC memory updates after protagonist interaction.

Expected coverage:

- NPC hears protagonist dialogue and stores it.
- NPC updates perception of protagonist when the protagonist reveals suspicion.
- NPC does not learn the player’s internal hypothesis unless spoken or acted upon.
- NPC future behavior can be affected by prior protagonist behavior.

1. Background Event Summary Seam

Test off-screen event processing.

Expected coverage:

- Background event can update NPC private memory.
- Background event does not automatically update player knowledge.
- Visible consequences can later be projected to the protagonist.
- Background event does not require full NPC-to-NPC dialogue.

1. Temporary Character Lifecycle Seam

Test system-generated temporary characters.

Expected coverage:

- Temporary character can appear naturally in protagonist output.
- Creation is logged internally.
- Temporary character has a knowledge boundary.
- Temporary character can be upgraded after becoming important.
- Upgrade preserves prior interactions.
- Upgrade uses only lightweight necessary background.

1. Relationship and Wrong-Belief Seam

Test actor relationship and mistaken belief behavior.

Expected coverage:

- A→B and B→A can differ.
- NPC can act on false belief.
- NPC does not automatically correct false belief from God State.
- Recognition of possible error depends on character ability, clues and random judgment.

1. Group Scene Speaking Seam

Test multi-NPC scenes.

Expected coverage:

- Not every NPC speaks every turn.
- Controller selects speaker, interrupter or silent reactor.
- Selected NPCs generate their own performance.
- Silent reactions are visible without exposing private thought.

1. Narrative Turn Contract Seam

Test whether a turn satisfies narrative value before prose quality is considered.

Expected coverage:

- A normal turn records or implies at least one Meaningful Change.
- Pure restatement, parallel description and decorative expansion are rejected as sole progress.
- Important NPCs have current emotion, immediate goal, hidden intent and voice considered.
- NPC private intent affects visible behavior without being directly revealed.
- Output stays first-person and protagonist-limited.

1. Adaptive Authored Protagonist Seam

Test protagonist voice, automatic low-risk behavior and player agency boundaries.

Expected coverage:

- Protagonist Core is present and used for inner monologue.
- Confirmed Adjustments override core and inferred tendencies.
- Inferred Tendencies include evidence and confidence.
- Single actions do not become permanent personality changes.
- Major relationship, moral and irreversible decisions remain with the player.

1. Decision Point and Suggestion Gate Seam

Test whether the system stops or continues at the right interaction boundary.

Expected coverage:

- Continuous Performance is allowed when no real decision is needed.
- Continuing still produces Meaningful Change or reaches a Decision Point.
- Decision Points make the current dramatic question clear.
- Suggestions are optional, 0 to 4 items, and answer one shared dramatic question.
- Suggestions fill input but do not auto-submit, and free input remains available.

### MVP Test Priority

P0 tests should prioritize:

1. Full story turn processing.
2. Visibility projection.
3. Player input parsing.
4. NPC private memory.
5. Random judgment.
6. Character agent output filtering.
7. Player Knowledge Log.
8. Negative consequence behavior.
9. Narrative Turn Contract.
10. Adaptive Authored Protagonist agency boundaries.
11. Decision Point and Suggestion Gate behavior.

P1 tests should add:

1. Full relationship graph.
2. Wrong beliefs.
3. Intent stages.
4. Group scene scheduling.
5. Temporary character upgrades.
6. Potential major relationship seeds.

## Out of Scope

The following are explicitly out of scope for MVP:

1. Large-scale open world simulation.
2. Full generative-agent town simulation.
3. Hundreds of NPCs.
4. Long-running always-on NPC agents.
5. Full NPC-to-NPC background dialogue simulation.
6. User-visible God State.
7. User-visible random logs.
8. User-editable NPC stats.
9. Author mode.
10. GM mode.
11. Debug mode for normal users.
12. Automatic shrinking of large worldbuilding input into small scenes.
13. Highly numerical TRPG-style mechanics.
14. Complex combat system.
15. Complex inventory and economy systems.
16. Full database-backed analytics or visualization.
17. Issue tracker automation, unless project tooling is available.
18. Codebase-specific implementation details that belong in future issue plans rather than product requirements.
19. Direct integration with SillyTavern as part of MVP.
20. Large-scale relationship graph across many characters.
21. Prewritten complete scripts.
22. Fixed chapter outlines, character routes or endings.
23. Pre-locked future event order.
24. Full Director Agent, Actor Agent and Renderer Agent split.
25. Multi-candidate event generation and scoring.
26. Complex Beat state machine.
27. Full event queue.
28. Complex emotional numeric systems or affection-stat gameplay.
29. Full foreshadowing management system.
30. Large-scale structured output protocol refactor.
31. Full visual-novel dialogue block protocol.
32. Performance and waiting-time optimization.

## Further Notes

This PRD is maintained against the repository documentation baseline. The current MVP should continue to protect the existing Story Workspace, player-visible output, turn history, random judgment and protagonist-view isolation boundaries while adding the narrative experience requirements above.

When turning this PRD into executable work, the next step should be:

1. Align terminology with `CONTEXT.md`.
2. Keep issue slices vertical and independently verifiable.
3. Convert P0 requirements into focused issues rather than one large narrative-system issue.
4. Keep P1/P2 out of first execution unless a P0 issue explicitly needs a small compatibility seam.
5. Avoid changing Claude Runner behavior, performance strategy or multi-agent architecture as part of narrative documentation work.

The MVP should be judged successful if a user can run a small story where:

- the user only controls the protagonist;
- the story reads like a first-person, character-driven visual novel;
- NPCs maintain private memory;
- hidden facts do not leak;
- player guesses are treated as hypotheses;
- NPCs react to what the protagonist says and does;
- normal turns produce perceptible narrative change;
- the protagonist has a stable voice and meaningful inner monologue;
- the system performs low-risk protagonist reactions while leaving major choices to the player;
- continuous scenes can flow until real decision points;
- suggestions appear only when they serve the current dramatic question;
- risky actions can fail;
- true randomness affects outcomes;
- off-screen events can change the world without becoming visible to the protagonist;
- negative and irreversible consequences are allowed when causally justified.
