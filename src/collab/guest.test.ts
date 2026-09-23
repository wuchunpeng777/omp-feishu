import { expect, test } from "bun:test";
import { formatSnapshot } from "../bridge/format.ts";
import { encodeBase64Url } from "./crypto.ts";
import { CollabGuest } from "./guest.ts";
import type { SessionEntry } from "./types.ts";

function testLink(): string {
  const secret = encodeBase64Url(crypto.getRandomValues(new Uint8Array(48)));
  return `https://my.omp.sh/#mgAYTZwEnpRQtca0CTgn-Q.${secret}`;
}

type GuestInternal = { apply(frame: Record<string, unknown>): void };

function apply(guest: CollabGuest, frame: Record<string, unknown>): void {
  const internal: GuestInternal = guest as unknown as GuestInternal;
  internal.apply(frame);
}

function user(text: string): SessionEntry {
  return {
    type: "message",
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

function assistant(text: string): SessionEntry {
  return {
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

test("sendPrompt 立刻开新轮，卡片不带上一轮输出", () => {
  const guest = new CollabGuest(testLink(), "飞书");
  apply(guest, {
    t: "welcome",
    header: { title: "2d1b04b6", cwd: "/tmp" },
    state: { isStreaming: false, model: { provider: "x", id: "y" } },
    agents: [],
    entryCount: 0,
    readOnly: false,
  });
  apply(guest, { t: "entry", entry: user("hi") });
  apply(guest, { t: "entry", entry: assistant("previous answer") });
  apply(guest, {
    t: "event",
    event: {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "previous answer" }] },
    },
  });
  apply(guest, { t: "state", state: { isStreaming: false, model: { provider: "x", id: "y" } } });

  guest.sendPrompt("你有什么能力");
  const snap = guest.snapshot();
  expect(snap.state?.isStreaming).toBe(true);
  expect(snap.streamingMessage).toBeUndefined();
  expect(typeof snap.turnStartedAt).toBe("number");
  const view = formatSnapshot(snap, "2d1b04b6");
  expect(view.markdown).toContain("你有什么能力");
  expect(view.markdown).not.toContain("previous answer");
  expect(view.markdown).not.toContain("**输出**");
  expect(view.streaming).toBe(true);
  expect(view.title.startsWith("运行中 · ")).toBe(true);
  guest.close();
});

test("主机回显同一条用户消息不重复", () => {
  const guest = new CollabGuest(testLink(), "飞书");
  apply(guest, {
    t: "welcome",
    header: { title: "omp", cwd: "/tmp" },
    state: {},
    agents: [],
    entryCount: 0,
    readOnly: false,
  });
  guest.sendPrompt("new question");
  apply(guest, { t: "entry", entry: user("new question") });
  const users = guest.snapshot().entries.filter(
    (entry) => entry.type === "message" && entry.message?.role === "user",
  );
  expect(users).toHaveLength(1);
  guest.close();
});

test("接入时主机已在跑，标题是时长不是会话名", () => {
  const guest = new CollabGuest(testLink(), "飞书");
  apply(guest, {
    t: "welcome",
    header: { title: "Fix 01 Trail Fragment Display", cwd: "/tmp" },
    state: { isStreaming: true, model: { provider: "x", id: "y" } },
    agents: [],
    entryCount: 0,
    readOnly: false,
  });
  const snap = guest.snapshot();
  expect(typeof snap.turnStartedAt).toBe("number");
  const view = formatSnapshot(snap, "Fix 01", {
    now: snap.turnStartedAt! + 65_000,
  });
  expect(view.title).toBe("运行中 · 1:05");
  const started = snap.turnStartedAt;
  apply(guest, { t: "event", event: { type: "agent_start" } });
  expect(guest.snapshot().turnStartedAt).toBe(started);
  guest.sendPrompt("还是有问题呢");
  expect(guest.snapshot().turnStartedAt).toBe(started);
  guest.close();
});

test("运行结束清掉计时，下一轮和 state 重新开始", () => {
  const guest = new CollabGuest(testLink(), "飞书");
  apply(guest, {
    t: "welcome",
    header: { title: "omp", cwd: "/tmp" },
    state: { isStreaming: false },
    agents: [],
    entryCount: 0,
    readOnly: false,
  });
  expect(guest.snapshot().turnStartedAt).toBeUndefined();
  apply(guest, { t: "state", state: { isStreaming: true } });
  const started = guest.snapshot().turnStartedAt;
  expect(typeof started).toBe("number");
  apply(guest, { t: "state", state: { isStreaming: false } });
  expect(guest.snapshot().turnStartedAt).toBeUndefined();
  apply(guest, { t: "event", event: { type: "agent_start" } });
  const next = guest.snapshot().turnStartedAt;
  expect(typeof next).toBe("number");
  apply(guest, { t: "event", event: { type: "agent_end" } });
  expect(guest.snapshot().turnStartedAt).toBeUndefined();
  expect(guest.snapshot().state?.isStreaming).toBe(false);
  guest.close();
});

test("主动离开不报 closed，卡片是已离开", () => {
  const guest = new CollabGuest(testLink(), "飞书");
  apply(guest, {
    t: "welcome",
    header: { title: "Fix 01 Trail Fragment Display", cwd: "/tmp" },
    state: { isStreaming: true, model: { provider: "x", id: "y" } },
    agents: [],
    entryCount: 0,
    readOnly: false,
  });
  guest.close();
  const snap = guest.snapshot();
  expect(snap.status).toBe("left");
  expect(snap.error).toBeUndefined();
  expect(snap.state?.isStreaming).toBe(false);
  const view = formatSnapshot(snap, "Fix 01 Trail Fragment Display");
  expect(view.title.startsWith("已离开")).toBe(true);
  expect(view.template).toBe("grey");
  expect(view.markdown).not.toContain("closed");
  expect(view.markdown).not.toContain("**断开**");
  expect(view.markdown).not.toContain("**错误**");
  expect(view.buttons.map((button) => button.action)).not.toContain("leave");
  expect(view.buttons.map((button) => button.action)).not.toContain("abort");
});
