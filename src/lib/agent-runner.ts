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
  /**
   * 回合超时信号（Issue 4）。
   * 由 Orchestrator 用 AbortSignal.timeout(ms) 创建。
   *
   * **Contract（强制）**：runner 必须响应此 signal：
   * - runTurn 入口应尽早 signal.throwIfAborted()。
   * - 长耗时操作（子进程、网络）必须把 signal 传到底层（child_process.exec / fetch）。
   * - abort 后 runner 必须停止执行并 reject 或返回 { success: false }。
   * 真实 CLI Runner（Issue 6）必须把 signal 传到子进程层，避免 timeout 后幽灵写入。
   * **不接受 Promise.race-only 超时**——那样超时后 runner 仍在后台写文件，破坏回滚原子性。
   */
  signal: AbortSignal;
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
