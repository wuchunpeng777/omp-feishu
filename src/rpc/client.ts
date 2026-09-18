/** 拉起 `omp --mode rpc` 并走 JSONL。 */

import { FrameAssembler } from "./assemble.ts";

export type RpcFrame = Record<string, unknown>;

export type RpcClientOptions = {
  ompBin: string;
  cwd: string;
};

type Pending = {
  resolve: (frame: RpcFrame) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type RpcStdin = {
  write: (data: string) => number | Promise<number>;
  end: (error?: Error) => number | Promise<number> | undefined;
};

export class RpcClient {
  private readonly assembler = new FrameAssembler();
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(frame: RpcFrame) => void>();
  private seq = 0;
  private stdin: RpcStdin;
  private closed = false;
  private lastReady?: RpcFrame;

  private constructor(private readonly proc: ReturnType<typeof Bun.spawn>) {
    const stdin = proc.stdin;
    if (!stdin || typeof stdin === "number") {
      throw new Error("omp rpc 没有可写 stdin");
    }
    this.stdin = stdin;
  }

  static async spawn(opts: RpcClientOptions): Promise<RpcClient> {
    const proc = Bun.spawn([opts.ompBin, "--mode", "rpc"], {
      cwd: opts.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
      windowsHide: true,
    });
    const client = new RpcClient(proc);
    void client.drainStderr();
    const ready = client.waitForReady();
    void client.readLoop();
    await ready;
    const versions = client.lastReady?.supportedProtocolVersions;
    if (Array.isArray(versions) && versions.includes(2)) {
      await client.request({ type: "negotiate_protocol", protocolVersion: 2 });
    }
    await client
      .request({
        type: "set_subagent_subscription",
        level: "events",
      })
      .catch(() => {});
    return client;
  }

  subscribe(listener: (frame: RpcFrame) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async request(command: RpcFrame, timeoutMs = 20_000): Promise<RpcFrame> {
    const id = String(command.id ?? `req_${++this.seq}`);
    const { promise, resolve, reject } = Promise.withResolvers<RpcFrame>();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new Error(`rpc 超时：${command.type}`));
    }, timeoutMs);
    this.pending.set(id, { resolve, reject, timer });
    this.write({ ...command, id });
    return promise;
  }

  send(command: RpcFrame): void {
    const id = String(command.id ?? `req_${++this.seq}`);
    this.write({ ...command, id });
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("rpc closed"));
    }
    this.pending.clear();
    try {
      this.stdin.end();
    } catch {
      /* ignore */
    }
    const timeout = setTimeout(() => this.proc.kill(), 3000);
    await this.proc.exited.catch(() => {});
    clearTimeout(timeout);
  }

  private write(frame: RpcFrame): void {
    if (this.closed) throw new Error("rpc 已关闭");
    this.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private waitForReady(): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const timer = setTimeout(() => reject(new Error("等待 omp rpc ready 超时")), 15_000);
    const off = this.subscribe((frame) => {
      if (frame.type === "ready") {
        this.lastReady = frame;
        clearTimeout(timer);
        off();
        resolve();
      }
    });
    void this.proc.exited.then((code) => {
      if (this.lastReady) return;
      clearTimeout(timer);
      off();
      reject(new Error(`omp rpc 退出 ${code}`));
    });
    return promise;
  }

  private async readLoop(): Promise<void> {
    const reader = this.proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) this.onLine(line);
          nl = buf.indexOf("\n");
        }
      }
    } finally {
      this.failAll(new Error("omp rpc stdout 关闭"));
    }
  }

  private onLine(line: string): void {
    let obj: RpcFrame;
    try {
      obj = JSON.parse(line) as RpcFrame;
    } catch {
      console.warn("rpc 非 JSON 行", line.slice(0, 120));
      return;
    }
    let frame: RpcFrame | undefined;
    try {
      frame = this.assembler.ingest(obj);
    } catch (err) {
      console.warn("rpc chunk", err);
      return;
    }
    if (!frame) return;
    if (frame.type === "response" && typeof frame.id === "string") {
      const pending = this.pending.get(frame.id);
      if (pending) {
        this.pending.delete(frame.id);
        clearTimeout(pending.timer);
        if (frame.success === false) {
          pending.reject(new Error(String(frame.error ?? "rpc failed")));
        } else {
          pending.resolve(frame);
        }
      }
    }
    for (const listener of this.listeners) listener(frame);
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private async drainStderr(): Promise<void> {
    const reader = this.proc.stderr.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) console.error("[omp]", line);
        nl = buf.indexOf("\n");
      }
    }
  }
}
