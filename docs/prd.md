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

### Proposed Test Seams

Because no codebase was available in the current conversation, these seams are expressed at the domain level rather than tied to existing modules.

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
18. Codebase-specific implementation details, because no repository was available in this conversation.
19. Direct integration with SillyTavern as part of MVP.
20. Large-scale relationship graph across many characters.

## Further Notes

This PRD was synthesized from prior requirement discussion. No code repository was available in the current conversation, so repository exploration, ADR review, issue publication and application of the `ready-for-agent` triage label could not be performed here.

When the repository and issue tracker are available, the next step should be:

1. Explore the current codebase and project glossary.
2. Align terminology with existing domain vocabulary.
3. Identify existing seams for story turn processing, model invocation, persistence, randomness and logging.
4. Convert the P0 section into one or more implementation issues.
5. Publish the issue with the `ready-for-agent` triage label.
6. Keep P1 and P2 as follow-up issues or milestone notes.

The MVP should be judged successful if a user can run a small story where:

- the user only controls the protagonist;
- NPCs maintain private memory;
- hidden facts do not leak;
- player guesses are treated as hypotheses;
- NPCs react to what the protagonist says and does;
- risky actions can fail;
- true randomness affects outcomes;
- off-screen events can change the world without becoming visible to the protagonist;
- negative and irreversible consequences are allowed when causally justified.