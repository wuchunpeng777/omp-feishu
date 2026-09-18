/** 作为 collab guest 接入主机，复刻 web client 的帧状态机。 */

import { encodeBase64Url } from "./crypto.ts";
import { isFullControl, parseCollabLink } from "./link.ts";
import { CollabTransport } from "./transport.ts";
import {
  COLLAB_PROTO,
  type AgentMessage,
  type GuestSnapshot,
  type GuestStatus,
  type LiveTool,
  type SessionEntry,
  type SubagentLifecycle,
  type SubagentProgress,
  type UiRequest,
} from "./types.ts";

export type GuestListener = (snapshot: GuestSnapshot) => void;

type TranscriptWaiter = {
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class CollabGuest {
  private readonly transport: CollabTransport;
  private readonly writeToken?: string;
  private readonly name: string;
  private readonly listeners = new Set<GuestListener>();
  private status: GuestStatus = "connecting";
  private error?: string;
  private readOnly = false;
  private welcomed = false;
  private header?: GuestSnapshot["header"];
  private entries: SessionEntry[] = [];
  private state?: GuestSnapshot["state"];
  private agents: unknown[] = [];
  private streamingMessage?: AgentMessage;
  private streamingEnded = false;
  private tools = new Map<string, LiveTool>();
  private uiRequest?: UiRequest;
  private uiQueue: UiRequest[] = [];
  private progress = new Map<string, SubagentProgress>();
  private lifecycle = new Map<string, SubagentLifecycle>();
  private notices: Array<{ level: string; message: string }> = [];
  private welcomeTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private transcriptWaiters = new Map<number, TranscriptWaiter>();

  constructor(linkText: string, displayName: string) {
    const parsed = parseCollabLink(linkText);
    if ("error" in parsed) throw new Error(parsed.error);
    this.name = displayName;
    this.writeToken = parsed.writeToken
      ? encodeBase64Url(parsed.writeToken)
      : undefined;
    this.readOnly = !isFullControl(parsed);
    this.transport = new CollabTransport(parsed, "guest");
    this.transport.onOpen = () => this.onSocketOpen();
    this.transport.onFrame = (frame) => this.onFrame(frame);
    this.transport.onClose = (reason, retryable) =>
      this.onSocketClose(reason, retryable);
  }

  connect(): void {
    if (this.status === "ended") {
      this.status = "connecting";
      this.error = undefined;
      this.emit();
    }
    this.transport.connect();
    if (!this.welcomed && this.welcomeTimer === null) {
      this.welcomeTimer = setTimeout(() => {
        this.welcomeTimer = null;
        if (!this.welcomed) this.end("timed out waiting for the host's welcome");
      }, 30_000);
    }
  }

  close(): void {
    this.clearWelcome();
    this.clearSnapshot();
    this.transport.close();
  }

  subscribe(listener: GuestListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): GuestSnapshot {
    return {
      status: this.status,
      error: this.error,
      readOnly: this.readOnly,
      header: this.header,
      entries: this.entries,
      state: this.state,
      agents: this.agents,
      streamingMessage: this.streamingMessage,
      streamingEnded: this.streamingEnded,
      tools: [...this.tools.values()],
      uiRequest: this.uiRequest,
      subagentProgress: [...this.progress.values()],
      subagentLifecycle: [...this.lifecycle.values()],
      notices: this.notices.slice(-8),
    };
  }

  sendPrompt(text: string): void {
    this.transport.send({ t: "prompt", text });
  }

  sendAbort(): void {
    this.transport.send({ t: "abort" });
  }

  sendUiResponse(reqId: string, value: unknown): void {
    this.transport.send({ t: "ui-response", reqId, value });
    if (this.uiRequest?.reqId === reqId) this.shiftUi();
    this.emit();
  }

  sendAgentCmd(cmd: string, agentId: string, text?: string): void {
    this.transport.send({ t: "agent-cmd", cmd, agentId, text });
  }

  private onSocketOpen(): void {
    this.transport.send({
      t: "hello",
      proto: COLLAB_PROTO,
      name: this.name,
      writeToken: this.writeToken,
    });
    this.status = this.welcomed ? "reconnecting" : "waiting";
    this.emit();
  }

  private onSocketClose(reason: string, retryable: boolean): void {
    this.clearSnapshot();
    if (this.status === "ended") return;
    if (retryable) {
      this.status = "reconnecting";
      this.emit();
      return;
    }
    this.end(reason);
  }

  private end(reason: string): void {
    if (this.status === "ended") return;
    this.clearWelcome();
    this.clearSnapshot();
    this.status = "ended";
    this.error = reason;
    for (const waiter of this.transcriptWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    this.transcriptWaiters.clear();
    this.notices = [];
    this.emit();
    this.transport.close();
  }

  private onFrame(frame: unknown): void {
    const rec = frame as { t?: string; [key: string]: unknown };
    try {
      this.apply(rec);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (rec.t === "welcome" && !this.welcomed) {
        this.end(`failed to apply session snapshot: ${msg}`);
        return;
      }
      this.notices.push({ level: "error", message: `failed to apply ${rec.t} frame` });
      this.emit();
    }
  }

  private apply(frame: { t?: string; [key: string]: unknown }): void {
    switch (frame.t) {
      case "welcome": {
        this.header = frame.header as GuestSnapshot["header"];
        this.entries = [];
        this.state = frame.state as GuestSnapshot["state"];
        this.agents = Array.isArray(frame.agents) ? [...frame.agents] : [];
        this.streamingMessage = undefined;
        this.streamingEnded = false;
        this.tools = new Map();
        this.progress = new Map();
        this.lifecycle = new Map();
        this.readOnly = frame.readOnly === true;
        this.welcomed = true;
        this.clearWelcome();
        this.status = frame.entryCount === 0 ? "live" : this.status;
        if (frame.entryCount === 0) this.clearSnapshot();
        else this.armSnapshot();
        this.error = undefined;
        break;
      }
      case "snapshot-chunk": {
        const extra = Array.isArray(frame.entries)
          ? (frame.entries as SessionEntry[])
          : [];
        this.entries = [...this.entries, ...extra];
        if (frame.final) {
          this.clearSnapshot();
          this.status = "live";
        } else {
          this.armSnapshot();
        }
        break;
      }
      case "entry": {
        const entry = frame.entry as SessionEntry;
        this.entries = [...this.entries, entry];
        if (
          this.streamingEnded &&
          entry?.type === "message" &&
          entry.message?.role === "assistant"
        ) {
          this.streamingMessage = undefined;
          this.streamingEnded = false;
        }
        break;
      }
      case "event":
        this.applyEvent(frame.event as { type?: string; [key: string]: unknown });
        break;
      case "state":
        this.state = frame.state as GuestSnapshot["state"];
        if (!this.state?.isStreaming) {
          for (const [id, tool] of this.tools) {
            if (tool.status !== "done") this.tools.set(id, { ...tool, status: "done" });
          }
          if (this.streamingEnded) {
            this.streamingMessage = undefined;
            this.streamingEnded = false;
          }
        }
        break;
      case "agents":
        this.agents = Array.isArray(frame.agents) ? [...frame.agents] : [];
        break;
      case "bus": {
        const data = frame.data as Record<string, unknown>;
        if (frame.channel === "task:subagent:progress") {
          const id = String(
            (data.progress as { id?: string } | undefined)?.id ?? data.id ?? "",
          );
          if (id) this.progress.set(id, data as SubagentProgress);
        } else if (frame.channel === "task:subagent:lifecycle") {
          const id = String(data.id ?? "");
          if (id) this.lifecycle.set(id, data as SubagentLifecycle);
        }
        break;
      }
      case "ui-request": {
        const request = frame.request as UiRequest;
        if (this.uiRequest) this.uiQueue = [...this.uiQueue, request];
        else this.uiRequest = request;
        break;
      }
      case "ui-request-end":
        if (this.uiRequest?.reqId === frame.reqId) this.shiftUi();
        else this.uiQueue = this.uiQueue.filter((r) => r.reqId !== frame.reqId);
        break;
      case "transcript": {
        const waiter = this.transcriptWaiters.get(Number(frame.reqId));
        if (waiter) {
          this.transcriptWaiters.delete(Number(frame.reqId));
          clearTimeout(waiter.timer);
          waiter.resolve(frame);
        }
        break;
      }
      case "bye":
        this.end(String(frame.reason ?? "host left"));
        return;
      case "error":
        if (!this.welcomed) {
          this.end(String(frame.message ?? "collab error"));
          return;
        }
        this.notices.push({
          level: "error",
          message: String(frame.message ?? "collab error"),
        });
        break;
      default:
        break;
    }
    this.emit();
  }

  private applyEvent(event: { type?: string; [key: string]: unknown }): void {
    switch (event.type) {
      case "message_start":
      case "message_update":
        if ((event.message as AgentMessage | undefined)?.role === "assistant") {
          this.streamingMessage = event.message as AgentMessage;
          this.streamingEnded = false;
        }
        break;
      case "message_end":
        if ((event.message as AgentMessage | undefined)?.role === "assistant") {
          this.streamingMessage = event.message as AgentMessage;
          this.streamingEnded = true;
        }
        break;
      case "tool_execution_start": {
        const id = String(event.toolCallId ?? "");
        this.tools.set(id, {
          toolCallId: id,
          toolName: String(event.toolName ?? "tool"),
          args: event.args,
          intent: event.intent as string | undefined,
          startedAt: Date.now(),
          status: "running",
        });
        break;
      }
      case "tool_execution_update": {
        const id = String(event.toolCallId ?? "");
        const prev = this.tools.get(id);
        this.tools.set(id, {
          toolCallId: id,
          toolName: String(event.toolName ?? prev?.toolName ?? "tool"),
          args: event.args ?? prev?.args,
          intent: (event.intent as string | undefined) ?? prev?.intent,
          partialResult: event.partialResult ?? prev?.partialResult,
          startedAt: prev?.startedAt ?? Date.now(),
          status: prev?.status ?? "running",
        });
        break;
      }
      case "tool_execution_end": {
        const id = String(event.toolCallId ?? "");
        const prev = this.tools.get(id);
        this.tools.set(id, {
          toolCallId: id,
          toolName: String(event.toolName ?? prev?.toolName ?? "tool"),
          args: event.args ?? prev?.args,
          intent: (event.intent as string | undefined) ?? prev?.intent,
          partialResult: event.result ?? event.partialResult ?? prev?.partialResult,
          startedAt: prev?.startedAt ?? Date.now(),
          status: "done",
        });
        break;
      }
      case "agent_start":
        if (this.state?.isStreaming !== true) {
          this.tools = new Map();
          this.progress = new Map();
        }
        if (this.state) this.state = { ...this.state, isStreaming: true };
        else this.state = { isStreaming: true };
        break;
      case "agent_end":
        if (this.state) this.state = { ...this.state, isStreaming: false };
        else this.state = { isStreaming: false };
        for (const [id, tool] of this.tools) {
          if (tool.status !== "done") this.tools.set(id, { ...tool, status: "done" });
        }
        break;
      case "notice":
        this.notices.push({
          level: String(event.level ?? "info"),
          message: String(event.message ?? ""),
        });
        break;
      case "auto_retry_start":
        this.notices.push({
          level: "info",
          message: `retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`,
        });
        break;
      default:
        break;
    }
  }

  private shiftUi(): void {
    const next = this.uiQueue[0];
    this.uiQueue = this.uiQueue.slice(1);
    this.uiRequest = next;
  }

  private armSnapshot(): void {
    this.clearSnapshot();
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      this.end("timed out waiting for the host's session snapshot");
    }, 30_000);
  }

  private clearWelcome(): void {
    if (this.welcomeTimer !== null) {
      clearTimeout(this.welcomeTimer);
      this.welcomeTimer = null;
    }
  }

  private clearSnapshot(): void {
    if (this.snapshotTimer !== null) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const listener of this.listeners) listener(snap);
  }
}

export function connectGuest(linkText: string, displayName: string): CollabGuest {
  const guest = new CollabGuest(linkText, displayName);
  guest.connect();
  return guest;
}
