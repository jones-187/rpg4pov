/**
 * Agent Runtime Adapter 的稳定边界。
 * Web/API 层只依赖此接口，不感知具体 runner 实现。
 * Runner 在 workspaceDir 内直接写文件（output.md + done.json），
 * 不通过返回值传递内容——Web 只从 turn/output.md 读取主角可见输出。
 */

/** 传给 AgentRunner 的回合请求 */
export interface TurnRequest {
  /** 故事 ID（UUID v4） */
  storyId: string;
  /** workspace 绝对路径，runner 在此目录内读写 */
  workspaceDir: string;
  /** 主角本回合输入（与 turn/input.md 内容一致，便利字段） */
  playerInput: string;
}

/** AgentRunner 返回的回合结果（不含内容，内容写文件） */
export interface TurnResult {
  /** runner 声明是否成功（Orchestrator 以磁盘 done.json 为权威） */
  success: boolean;
  /** 失败时的内部诊断信息 */
  error?: string;
}

/**
 * Agent Runtime Adapter 接口。
 * 实现方在 runTurn 内：
 * 1. 读取 workspace 当前状态（含 turn/input.md）
 * 2. 写 turn/output.md（固定主角可见输出）
 * 3. 写 turn/done.json（成功标记）
 * 4. 返回 { success: true }
 * 失败时返回 { success: false, error } 或抛异常（由 Orchestrator 捕获）。
 */
export interface AgentRunner {
  runTurn(req: TurnRequest): Promise<TurnResult>;
}
