/**
 * 通用轮询看门狗骨架（pi 三产物早退 / claude done.json 早退共用）。
 *
 * 语义：intervalMs 轮询 tick()；tick 返回 true 即置 fired、回调 onFire
 * （通常为 kill 子进程）并停止。stop() 幂等。enabled=false 时返回惰性
 * 句柄（env 开关关闭路径）。
 */
export interface PollWatchHandle {
  stop(): void;
  /** 看门狗已判定完成并触发 onFire */
  fired: boolean;
}

export function startPollWatcher(
  intervalMs: number,
  tick: () => Promise<boolean>,
  onFire: () => void,
  enabled = true,
): PollWatchHandle {
  if (!enabled) return { stop: () => {}, fired: false };
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const handle: PollWatchHandle = {
    fired: false,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
  const loop = async () => {
    if (stopped) return;
    let complete = false;
    try {
      complete = await tick();
    } catch {
      complete = false;
    }
    if (stopped) return;
    if (complete) {
      handle.fired = true;
      handle.stop();
      onFire();
      return;
    }
    timer = setTimeout(loop, intervalMs) as unknown as NodeJS.Timeout;
  };
  timer = setTimeout(loop, intervalMs) as unknown as NodeJS.Timeout;
  return handle;
}
