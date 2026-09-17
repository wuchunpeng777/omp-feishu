/** collab 中继传输：4 字节路由前缀 + AES-GCM 负载。 */

import { importRoomKey, openFrame, sealFrame } from "./crypto.ts";
import type { ParsedCollabLink } from "./link.ts";

const ROUTING_PREFIX = 4;
const CLOSE: Record<number, string> = {
  4001: "room closed",
  4004: "no such room",
  4009: "a host is already connected for this room",
  4029: "room is full",
};

export type TransportRole = "guest" | "host";

export type ControlMessage = Record<string, unknown>;

function wrapEnvelope(peerId: number, sealed: Uint8Array): Uint8Array {
  const out = new Uint8Array(ROUTING_PREFIX + sealed.byteLength);
  new DataView(out.buffer).setUint32(0, peerId, false);
  out.set(sealed, ROUTING_PREFIX);
  return out;
}

function unwrapEnvelope(
  bytes: Uint8Array,
): { peerId: number; payload: Uint8Array } | null {
  if (bytes.byteLength < ROUTING_PREFIX) return null;
  return {
    peerId: new DataView(
      bytes.buffer,
      bytes.byteOffset,
      ROUTING_PREFIX,
    ).getUint32(0, false),
    payload: bytes.subarray(ROUTING_PREFIX),
  };
}

export class CollabTransport {
  onOpen?: () => void;
  onFrame?: (frame: unknown, peerId: number) => void;
  onControl?: (msg: ControlMessage) => void;
  onClose?: (reason: string, retryable: boolean) => void;

  private readonly wsUrl: string;
  private readonly role: TransportRole;
  private readonly key: Promise<CryptoKey>;
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private closed = false;
  private seenLive = false;
  private sendQueue: Promise<void> = Promise.resolve();
  private recvQueue: Promise<void> = Promise.resolve();
  private pending: Uint8Array[] = [];

  constructor(link: ParsedCollabLink, role: TransportRole) {
    this.wsUrl = link.wsUrl;
    this.role = role;
    this.key = importRoomKey(link.key);
  }

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (this.socket || this.reconnectTimer !== undefined) return;
    this.closed = false;
    this.seenLive = false;
    this.attempts = 0;
    this.openSocket();
  }

  send(frame: unknown, peerId = 0): void {
    this.sendQueue = this.sendQueue
      .then(async () => {
        if (this.closed) return;
        const sealed = await sealFrame(await this.key, frame);
        const envelope = wrapEnvelope(peerId, sealed);
        const socket = this.socket;
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(envelope);
          return;
        }
        if (this.pending.length >= 256) return;
        this.pending.push(envelope);
      })
      .catch(() => {});
  }

  close(): void {
    const had = this.socket !== null || this.reconnectTimer !== undefined;
    this.clearReconnect();
    const already = this.closed;
    this.closed = true;
    this.seenLive = false;
    this.pending.length = 0;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close(1000);
      } catch {
        /* ignore */
      }
    }
    if (had && !already) this.onClose?.("closed", false);
  }

  private openSocket(): void {
    const socket = new WebSocket(`${this.wsUrl}?role=${this.role}`);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      if (!this.seenLive) this.attempts = 0;
      for (const frame of this.pending) socket.send(frame);
      this.pending.length = 0;
      this.onOpen?.();
    };
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      this.handleMessage(socket, ev.data);
    };
    socket.onerror = () => {};
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.handleClose(ev.code, ev.reason);
    };
  }

  private handleMessage(socket: WebSocket, data: unknown): void {
    if (typeof data === "string") {
      try {
        this.onControl?.(JSON.parse(data) as ControlMessage);
      } catch {
        console.warn("collab: ignoring malformed control message");
      }
      return;
    }
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : data instanceof Uint8Array
          ? data
          : null;
    if (!bytes) {
      console.warn("collab: ignoring binary message of unexpected shape");
      return;
    }
    const envelope = unwrapEnvelope(bytes);
    if (!envelope) {
      console.warn("collab: ignoring truncated envelope");
      return;
    }
    this.recvQueue = this.recvQueue
      .then(async () => {
        if (this.socket !== socket) return;
        let frame: unknown;
        try {
          frame = await openFrame(await this.key, envelope.payload);
        } catch {
          this.fail("bad key or corrupted frame");
          return;
        }
        if (this.socket !== socket) return;
        this.seenLive = false;
        this.attempts = 0;
        this.onFrame?.(frame, envelope.peerId);
      })
      .catch(() => {});
  }

  private handleClose(code: number, reason: string): void {
    if (this.closed) return;
    const mapped = CLOSE[code];
    const text = mapped ?? (reason || `connection lost (code ${code})`);
    if (this.role === "guest" && (code === 4001 || (code === 4004 && this.seenLive))) {
      this.seenLive = true;
      this.onClose?.(text, true);
      this.scheduleReconnect();
      return;
    }
    if (mapped !== undefined) {
      this.closed = true;
      this.pending.length = 0;
      this.onClose?.(mapped, false);
      return;
    }
    this.onClose?.(text, true);
    this.scheduleReconnect();
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.clearReconnect();
    this.pending.length = 0;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close(1000);
      } catch {
        /* ignore */
      }
    }
    this.onClose?.(reason, false);
  }

  private scheduleReconnect(): void {
    const delay = Math.min(1000 * 2 ** this.attempts, 30_000);
    this.attempts++;
    const jitter = delay * (0.75 + Math.random() * 0.5);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.closed) return;
      this.openSocket();
    }, jitter);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }
}
