import { expect, test } from "bun:test";
import { formatSnapshot } from "./format.ts";
import type { GuestSnapshot } from "../collab/types.ts";

function snap(partial: Partial<GuestSnapshot> = {}): GuestSnapshot {
  return {
    status: "live",
    readOnly: false,
    header: { title: "omp", cwd: "/tmp" },
    entries: [
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
    ],
    state: { isStreaming: false, model: { provider: "x", id: "y" } },
    agents: [],
    streamingEnded: true,
    tools: [],
    subagentProgress: [],
    subagentLifecycle: [],
    notices: [],
    ...partial,
  };
}

test("collab 卡片有离开", () => {
  const view = formatSnapshot(snap(), "demo");
  expect(view.buttons.map((b) => b.action)).toContain("leave");
  expect(view.buttons.map((b) => b.action)).toContain("abort");
});

test("RPC 卡片不露离开", () => {
  const view = formatSnapshot(snap(), "omp", { showLeave: false });
  expect(view.buttons.map((b) => b.action)).not.toContain("leave");
  expect(view.markdown).toContain("/tmp");
  expect(view.markdown).toContain("hi");
});

test("运行中卡片标记 streaming", () => {
  const live = formatSnapshot(
    snap({ state: { isStreaming: true, model: { provider: "x", id: "y" } } }),
    "omp",
    { showLeave: false },
  );
  expect(live.streaming).toBe(true);
  expect(live.template).toBe("orange");
  const idle = formatSnapshot(snap(), "omp", { showLeave: false });
  expect(idle.streaming).toBe(false);
});

test("过程区留下已完成工具和进行中输出", () => {
  const view = formatSnapshot(
    snap({
      state: { isStreaming: true, model: { provider: "x", id: "y" } },
      tools: [
        {
          toolCallId: "1",
          toolName: "bash",
          args: { command: "ls" },
          startedAt: 1,
          status: "done",
          partialResult: "a.txt",
        },
        {
          toolCallId: "2",
          toolName: "read",
          args: { path: "a.txt" },
          startedAt: 2,
          status: "running",
          partialResult: "hello world",
        },
      ],
      subagentProgress: [{ progress: { id: "s1", label: "explore", percent: 0.4 } }],
    }),
    "omp",
    { showLeave: false },
  );
  expect(view.markdown).toContain("**过程**");
  expect(view.markdown).toContain("完成 `bash` ls");
  expect(view.markdown).toContain("进行中 `read` a.txt");
  expect(view.markdown).toContain("hello world");
  expect(view.markdown).toContain("explore 40%");
});
