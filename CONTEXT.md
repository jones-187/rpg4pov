# 项目术语表 (Glossary)

本文件是领域术语表，记录项目中关键概念的规范定义。不含实现细节。

## 故事相关

### Story Workspace
每个 storyId 对应的独立工作空间，是故事状态的**唯一事实来源**。采用 Markdown-first 布局，包含故事元数据、世界设定、主角信息、NPC 角色卡、日志和回合输入输出。

### Story Turn（故事回合）
用户输入主角行动后，系统执行的一次完整处理周期。一个回合从用户输入开始，到返回主角可见输出结束。同一 storyId 的回合串行执行。

### Player-visible Output（主角可见输出）
回合完成后，用户能通过 Web 界面看到的内容。**只来自 `turn/output.md`**，不包含 agent stdout、内部日志、God State、NPC 私有记忆或随机判定日志。

## Agent 相关

### Agent Runtime Adapter（Agent 运行时适配器）
Web/API 层与具体 agent 实现之间的**稳定边界**。在代码中体现为 `AgentRunner` 接口。Web 层只依赖此接口，不感知具体 runner（Fake Agent、Claude Code CLI 等）。

### Agent Runner（Agent 运行器）
`AgentRunner` 接口的具体实现。在 Story Workspace 目录内执行一个回合：读取当前状态、写入主角可见输出、写入运行成功标记。每回合冷启动，不依赖长期会话记忆。

### Turn Orchestrator（回合编排器）
回合生命周期的编排者。负责：清理上回合标记 → 写入主角输入 → 调用 Agent Runner → 检查磁盘权威状态 → 读取主角可见输出。持有 AgentRunner 实例，对回合内的所有失败负责。

### Fake Agent Runner（假 Agent 运行器）
Issue 3 引入的验证用 Agent Runner 实现。不接入真实大模型，读取主角输入后生成固定格式输出，用于跑通架构闭环。是临时验证组件，非永久产品运行时。

## 回合状态相关

### Done Marker（运行成功标记）
`turn/done.json` 文件，由 Agent Runner 在回合成功完成后写入。Turn Orchestrator 以此文件的**磁盘存在性和状态**为权威依据判断回合是否成功，不依赖 runner 的返回值。回合开始前由 Orchestrator 清理。
