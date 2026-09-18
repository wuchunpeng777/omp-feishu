/** 把 omp RPC 事件收成和 collab 一样的 GuestSnapshot。 */

import type {
  AgentMessage,
  GuestSnapshot,
  LiveTool,
  SessionEntry,
  SubagentLifecycle,
  SubagentProgress,
  UiRequest,
} from "../collab/types.ts";
import { RpcClient, type RpcFrame } from "./client.ts";

export type RpcSessionOptions = {
  ompBin: string;
  cwd: string;
  sessionFile?: string;
};

export class RpcSession {
  private readonly listeners = new Set<(snap: GuestSnapshot) => void>();
  private entries: SessionEntry[] = [];
  private tools = new Map<string, LiveTool>();
  private progress = new Map<string, SubagentProgress>();
  private lifecycle = new Map<string, SubagentLifecycle>();
  private notices: Array<{ level: string; message: string }> = [];
  private streamingMessage?: AgentMessage;
  private streamingEnded = false;
  private uiRequest?: UiRequest;
  private status: GuestSnapshot["status"] = "connecting";
  private error?: string;
  private header: GuestSnapshot["header"];
  private state: GuestSnapshot["state"] = {};
  private sessionFile?: string;
  private off?: () => void;
  private awaitingTurn = false;

  private constructor(
    private client: RpcClient,
    private cwd: string,
  ) {}

  static async start(opts: RpcSessionOptions): Promise<RpcSession> {
    const client = await RpcClient.spawn({
      ompBin: opts.ompBin,
      cwd: opts.cwd,
    });
    const session = new RpcSession(client, opts.cwd);
    session.off = client.subscribe((frame) => session.onFrame(frame));
    session.status = "live";
    if (opts.sessionFile) {
      await client
        .request({ type: "switch_session", sessionPath: opts.sessionFile })
        .catch((err) => {
          session.notices.push({
            level: "info",
            message: `未能恢复会话，开新的：${err instanceof Error ? err.message : String(err)}`,
          });
        });
    }
    await session.refreshState();
    await session.loadHistory();
    session.emit();
    return session;
  }

  snapshot(): GuestSnapshot {
    return {
      status: this.status,
      error: this.error,
      readOnly: false,
      header: this.header,
      entries: this.entries,
      state: this.state,
      agents: [],
      streamingMessage: this.streamingMessage,
      streamingEnded: this.streamingEnded,
      tools: [...this.tools.values()],
      uiRequest: this.uiRequest,
      subagentProgress: [...this.progress.values()],
      subagentLifecycle: [...this.lifecycle.values()],
      notices: this.notices.slice(-8),
    };
  }

  subscribe(listener: (snap: GuestSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSessionFile(): string | undefined {
    return this.sessionFile;
  }

  getCwd(): string {
    return this.cwd;
  }

  async prompt(text: string): Promise<void> {
    this.entries = [
      ...this.entries,
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text }] },
      },
    ];
    this.awaitingTurn = true;
    this.emit();
    const streaming = this.state?.isStreaming === true;
    const res = await this.client.request({
      type: "prompt",
      message: text,
      ...(streaming ? { streamingBehavior: "followUp" } : {}),
    });
    const data = res.data as Record<string, unknown> | undefined;
    if (data?.agentInvoked === false) this.awaitingTurn = false;
  }

  abort(): void {
    this.client.send({ type: "abort" });
  }

  async newSession(): Promise<void> {
    await this.client.request({ type: "new_session" });
    this.entries = [];
    this.tools = new Map();
    this.progress = new Map();
    this.lifecycle = new Map();
    this.streamingMessage = undefined;
    this.streamingEnded = false;
    this.uiRequest = undefined;
    this.awaitingTurn = false;
    await this.refreshState();
    this.emit();
  }

  sendUiResponse(reqId: string, value: unknown): void {
    const method = this.uiRequest?.method;
    if (method === "confirm") {
      const confirmed =
        value === true || value === "true" || value === "确认" || value === "是";
      this.client.send({
        type: "extension_ui_response",
        id: reqId,
        confirmed,
      });
    } else if (value === undefined) {
      this.client.send({
        type: "extension_ui_response",
        id: reqId,
        cancelled: true,
      });
    } else {
      this.client.send({
        type: "extension_ui_response",
        id: reqId,
        value,
      });
    }
    if (this.uiRequest?.reqId === reqId) this.uiRequest = undefined;
    this.emit();
  }

  async waitUntilIdle(timeoutMs = 180_000): Promise<void> {
    if (!this.awaitingTurn && this.state?.isStreaming !== true) return;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const timer = setTimeout(() => reject(new Error("等待 omp 结束超时")), timeoutMs);
    const off = this.subscribe((snap) => {
      if (!this.awaitingTurn && snap.state?.isStreaming !== true && snap.status === "live") {
        clearTimeout(timer);
        off();
        resolve();
      }
      if (snap.status === "ended") {
        clearTimeout(timer);
        off();
        reject(new Error(snap.error ?? "rpc ended"));
      }
    });
    return promise;
  }

  async dispose(): Promise<void> {
    this.off?.();
    this.status = "ended";
    this.emit();
    await this.client.dispose();
  }

  private async refreshState(): Promise<void> {
    const res = await this.client.request({ type: "get_state" });
    this.applyState((res.data ?? {}) as Record<string, unknown>);
  }

  private async loadHistory(): Promise<void> {
    try {
      const res = await this.client.request({
        type: "get_messages_page",
        limit: 40,
      });
      const data = (res.data ?? {}) as Record<string, unknown>;
      const messages = Array.isArray(data.messages) ? data.messages : [];
      const entries: SessionEntry[] = [];
      for (const item of messages) {
        if (!item || typeof item !== "object") continue;
        entries.push({ type: "message", message: item });
      }
      if (entries.length > 0) this.entries = entries;
    } catch {
      /* 旧 runtime 可能没有分页接口 */
    }
  }

  private applyState(data: Record<string, unknown>): void {
    const modelRaw = data.model;
    const model =
      modelRaw && typeof modelRaw === "object"
        ? {
            provider:
              "provider" in modelRaw && typeof modelRaw.provider === "string"
                ? modelRaw.provider
                : undefined,
            id:
              "id" in modelRaw && typeof modelRaw.id === "string"
                ? modelRaw.id
                : undefined,
          }
        : undefined;
    const usageRaw = data.contextUsage;
    const usage =
      usageRaw && typeof usageRaw === "object"
        ? {
            tokens:
              "tokens" in usageRaw && typeof usageRaw.tokens === "number"
                ? usageRaw.tokens
                : undefined,
            percent:
              "percent" in usageRaw && typeof usageRaw.percent === "number"
                ? usageRaw.percent
                : undefined,
            contextWindow:
              "contextWindow" in usageRaw && typeof usageRaw.contextWindow === "number"
                ? usageRaw.contextWindow
                : undefined,
          }
        : undefined;
    this.sessionFile =
      typeof data.sessionFile === "string" ? data.sessionFile : this.sessionFile;
    this.header = {
      title:
        typeof data.sessionName === "string" && data.sessionName
          ? data.sessionName
          : "omp",
      cwd: this.cwd,
      id: typeof data.sessionId === "string" ? data.sessionId : undefined,
    };
    this.state = {
      ...this.state,
      isStreaming: data.isStreaming === true,
      model: model ?? this.state?.model,
      thinkingLevel:
        typeof data.thinkingLevel === "string"
          ? data.thinkingLevel
          : this.state?.thinkingLevel,
      context: usage,
    };
  }

  private onFrame(frame: RpcFrame): void {
    const type = String(frame.type ?? "");
    switch (type) {
      case "agent_start":
        if (this.state?.isStreaming !== true) {
          this.tools = new Map();
          this.progress = new Map();
        }
        this.state = { ...this.state, isStreaming: true };
        this.awaitingTurn = true;
        break;
      case "agent_end":
        if (frame.isTerminal === false) break;
        this.state = { ...this.state, isStreaming: false };
        this.awaitingTurn = false;
        for (const [id, tool] of this.tools) {
          if (tool.status !== "done") this.tools.set(id, { ...tool, status: "done" });
        }
        if (this.streamingEnded) {
          this.streamingMessage = undefined;
          this.streamingEnded = false;
        }
        void this.refreshState().catch(() => {});
        break;
      case "prompt_result":
        if (frame.agentInvoked !== true) {
          this.awaitingTurn = false;
          this.state = { ...this.state, isStreaming: false };
        }
        break;
      case "message_start":
      case "message_update":
      case "message_end":
        this.applyMessage(type, frame);
        break;
      case "tool_execution_start":
        this.tools.set(String(frame.toolCallId ?? ""), {
          toolCallId: String(frame.toolCallId ?? ""),
          toolName: String(frame.toolName ?? "tool"),
          args: frame.args,
          intent: typeof frame.intent === "string" ? frame.intent : undefined,
          startedAt: Date.now(),
          status: "running",
        });
        break;
      case "tool_execution_update": {
        const id = String(frame.toolCallId ?? "");
        const prev = this.tools.get(id);
        this.tools.set(id, {
          toolCallId: id,
          toolName: String(frame.toolName ?? prev?.toolName ?? "tool"),
          args: frame.args ?? prev?.args,
          intent:
            typeof frame.intent === "string" ? frame.intent : prev?.intent,
          partialResult: frame.partialResult ?? prev?.partialResult,
          startedAt: prev?.startedAt ?? Date.now(),
          status: prev?.status ?? "running",
        });
        break;
      }
      case "tool_execution_end": {
        const id = String(frame.toolCallId ?? "");
        const prev = this.tools.get(id);
        this.tools.set(id, {
          toolCallId: id,
          toolName: String(frame.toolName ?? prev?.toolName ?? "tool"),
          args: frame.args ?? prev?.args,
          intent:
            typeof frame.intent === "string" ? frame.intent : prev?.intent,
          partialResult: frame.result ?? frame.partialResult ?? prev?.partialResult,
          startedAt: prev?.startedAt ?? Date.now(),
          status: "done",
        });
        break;
      }
      case "subagent_lifecycle": {
        const id = String(frame.id ?? frame.subagentId ?? "");
        if (id) {
          this.lifecycle.set(id, {
            id,
            name: typeof frame.name === "string" ? frame.name : undefined,
            status: typeof frame.status === "string" ? frame.status : undefined,
            agent: typeof frame.agent === "string" ? frame.agent : undefined,
          });
        }
        break;
      }
      case "subagent_progress": {
        const data = (frame.progress ?? frame) as Record<string, unknown>;
        const id = String(data.id ?? "");
        if (id) {
          this.progress.set(id, {
            progress: {
              id,
              label: typeof data.label === "string" ? data.label : undefined,
              percent: typeof data.percent === "number" ? data.percent : undefined,
            },
          });
        }
        break;
      }
      case "extension_ui_request": {
        const method = typeof frame.method === "string" ? frame.method : "";
        if (
          method === "notify" ||
          method === "setStatus" ||
          method === "setWidget" ||
          method === "setTitle" ||
          method === "set_editor_text" ||
          method === "open_url"
        ) {
          break;
        }
        this.uiRequest = {
          reqId: String(frame.id ?? ""),
          method: method || undefined,
          title: typeof frame.title === "string" ? frame.title : undefined,
          message: typeof frame.message === "string" ? frame.message : undefined,
          options: Array.isArray(frame.options)
            ? frame.options.filter((item): item is string => typeof item === "string")
            : method === "confirm"
              ? ["确认", "取消"]
              : undefined,
        };
        break;
      }
      case "notice":
        this.notices.push({
          level: String(frame.level ?? "info"),
          message: String(frame.message ?? ""),
        });
        break;
      case "command_output":
        this.notices.push({
          level: "info",
          message: String(frame.output ?? frame.message ?? ""),
        });
        break;
      case "model_changed":
        if (frame.model && typeof frame.model === "object") {
          const model = frame.model;
          const provider =
            "provider" in model && typeof model.provider === "string"
              ? model.provider
              : undefined;
          const id =
            "id" in model && typeof model.id === "string" ? model.id : undefined;
          this.state = { ...this.state, model: { provider, id } };
        }
        break;
      default:
        break;
    }
    this.emit();
  }

  private applyMessage(type: string, frame: RpcFrame): void {
    const message = asAgentMessage(frame.message);
    const delta = textDelta(frame.assistantMessageEvent);
    if (message?.role === "assistant" || delta !== undefined) {
      if (message) this.streamingMessage = message;
      else if (delta !== undefined) {
        const prev = messageText(this.streamingMessage);
        this.streamingMessage = {
          role: "assistant",
          content: [{ type: "text", text: prev + delta }],
        };
      }
      this.streamingEnded = type === "message_end";
      if (type === "message_end" && this.streamingMessage) {
        this.entries = [
          ...this.entries,
          { type: "message", message: this.streamingMessage },
        ];
      }
    }
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const listener of this.listeners) listener(snap);
  }
}

function asAgentMessage(value: unknown): AgentMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value;
}

function textDelta(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const event = value as { type?: string; delta?: string };
  if (event.type !== "text_delta") return undefined;
  return typeof event.delta === "string" ? event.delta : "";
}

function messageText(message: AgentMessage | undefined): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || !("type" in block)) continue;
    if (block.type !== "text") continue;
    const text = "text" in block && typeof block.text === "string" ? block.text : "";
    parts.push(text);
  }
  return parts.join("");
}
