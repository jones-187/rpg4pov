import { spawn as realSpawn, type ChildProcess } from "node:child_process";

/** Shared external-process seam used by Pi and Claude runners. */
export type SpawnFn = (cmd: string, args: string[], opts: SpawnOpts) => Promise<SpawnResult>;

export interface SpawnOpts {
  cwd: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
  stdinData: string;
  stdio: ["pipe", "pipe", "pipe"];
  /** Optional line side-channel; stdout aggregation remains authoritative. */
  onStdoutLine?: (line: string) => void;
  /** Exposes the child so runner abort handlers can terminate it. */
  _child?: { kill(sig: string): void };
}

export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  aborted?: boolean;
}

/**
 * Spawn a controlled child process, pass stdin once, and collect diagnostics.
 * stdout is a bounded tail because pi JSON events can repeat cumulative
 * partial content for a very large stream. Line callbacks are deliberately a
 * side channel: malformed preview data must never break the main process.
 */
export function defaultSpawn(cmd: string, args: string[], opts: SpawnOpts): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = realSpawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv,
      stdio: opts.stdio,
    }) as ChildProcess;

    child.stdin?.end(opts.stdinData);

    let stdout = "";
    let stderr = "";
    const STDOUT_TAIL_LIMIT = 64 * 1024;
    let lineBuf = "";
    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      stdout = (stdout + text).slice(-STDOUT_TAIL_LIMIT);
      if (!opts.onStdoutLine) return;
      lineBuf += text;
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() === "") continue;
        try {
          opts.onStdoutLine(line);
        } catch {
          // Side-channel errors are intentionally isolated from spawn.
        }
      }
    });
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr, aborted: opts.signal.aborted });
    });

    opts._child = { kill: (sig) => child.kill(sig as NodeJS.Signals) };
  });
}
