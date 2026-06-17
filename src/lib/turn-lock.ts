/**
 * 进程内串行锁（Issue 4）。
 * 同一 storyId 同时只能执行一个回合；第二次 acquire 抛 TurnBusyError。
 * 锁只存内存——进程重启自动复位（瞬态，不持久化）。
 * 适用于单 Docker 单 Node 进程的 MVP；多进程场景需外部协调（P2）。
 */

/** 并发拒绝错误。route 层据此返回 409。 */
export class TurnBusyError extends Error {
  constructor(public readonly storyId: string) {
    super(`story ${storyId} is currently running a turn`);
    this.name = "TurnBusyError";
  }
}

export class TurnLock {
  private locked = new Set<string>();

  /**
   * 获取 storyId 的锁。若已被占用，抛 TurnBusyError。
   * 返回 release 函数（幂等，可多次调用）。
   */
  acquire(storyId: string): () => void {
    if (this.locked.has(storyId)) {
      throw new TurnBusyError(storyId);
    }
    this.locked.add(storyId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.locked.delete(storyId);
    };
  }

  /** 查询 storyId 是否未被锁定（true = 可获取）。 */
  isReleased(storyId: string): boolean {
    return !this.locked.has(storyId);
  }
}
