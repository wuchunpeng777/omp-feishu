/** collab guest 快照与帧类型。 */

export const COLLAB_PROTO = 3;

export type GuestStatus =
  | "connecting"
  | "waiting"
  | "live"
  | "reconnecting"
  | "ended"
  | "left";

export type CollabState = {
  isStreaming?: boolean;
  model?: { provider?: string; id?: string; name?: string } | string;
  thinkingLevel?: string;
  context?: { tokens?: number; percent?: number; contextWindow?: number };
  participants?: unknown[];
  [key: string]: unknown;
};

export type SessionEntry = {
  type?: string;
  id?: string;
  message?: AgentMessage;
  [key: string]: unknown;
};

export type AgentMessage = {
  role?: string;
  content?: unknown;
  [key: string]: unknown;
};

export type LiveTool = {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  intent?: string;
  partialResult?: unknown;
  startedAt: number;
  status?: "running" | "done";
};

export type UiRequest = {
  reqId: string;
  method?: string;
  title?: string;
  message?: string;
  options?: unknown[];
  optionDetails?: Array<{ description?: string }>;
  [key: string]: unknown;
};

export type SubagentProgress = {
  progress?: { id?: string; label?: string; percent?: number };
  [key: string]: unknown;
};

export type SubagentLifecycle = {
  id: string;
  name?: string;
  status?: string;
  agent?: string;
  [key: string]: unknown;
};

export type GuestSnapshot = {
  status: GuestStatus;
  error?: string;
  readOnly: boolean;
  header?: { title?: string; cwd?: string; id?: string; [key: string]: unknown };
  entries: SessionEntry[];
  state?: CollabState;
  agents: unknown[];
  streamingMessage?: AgentMessage;
  streamingEnded: boolean;
  turnStartedAt?: number;
  tools: LiveTool[];
  uiRequest?: UiRequest;
  subagentProgress: SubagentProgress[];
  subagentLifecycle: SubagentLifecycle[];
  notices: Array<{ level: string; message: string }>;
};

export type OutboundFrame =
  | { t: "hello"; proto: number; name: string; writeToken?: string }
  | { t: "prompt"; text: string }
  | { t: "abort" }
  | { t: "ui-response"; reqId: string; value: unknown }
  | { t: "agent-cmd"; cmd: string; agentId: string; text?: string }
  | { t: "fetch-transcript"; reqId: number; agentId: string; fromByte: number };
