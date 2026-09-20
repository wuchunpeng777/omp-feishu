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
