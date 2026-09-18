import { expect, test } from "bun:test";
import { formatHostList, formatModelList, formatSnapshot, formatThinkCard } from "./format.ts";
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

test("会话报错显示错误而不是断开", () => {
  const view = formatSnapshot(snap({ error: "429 overloaded", status: "live" }), "omp", {
    showLeave: false,
  });
  expect(view.title.startsWith("错误")).toBe(true);
  expect(view.template).toBe("red");
  expect(view.streaming).toBe(false);
  expect(view.markdown).toContain("**错误** 429 overloaded");
});

test("进程断开显示断开", () => {
  const view = formatSnapshot(
    snap({ error: "omp rpc stdout 关闭", status: "ended" }),
    "omp",
    { showLeave: false },
  );
  expect(view.title.startsWith("错误")).toBe(true);
  expect(view.markdown).toContain("**断开** omp rpc stdout 关闭");
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

test("RPC 空闲卡片有模型和思考按钮", () => {
  const view = formatSnapshot(snap(), "omp", {
    showLeave: false,
    showModelControls: true,
  });
  expect(view.buttons.map((b) => b.action)).toEqual(["abort", "models", "think"]);
});

test("运行中不露模型和思考按钮", () => {
  const view = formatSnapshot(
    snap({ state: { isStreaming: true, model: { provider: "x", id: "y" } } }),
    "omp",
    { showLeave: false, showModelControls: true },
  );
  expect(view.buttons.map((b) => b.action)).toEqual(["abort"]);
});

test("模型列表按钮带 provider 和 id", () => {
  const view = formatModelList(
    [
      { provider: "xai", id: "grok-4.6" },
      { provider: "anthropic", id: "claude-opus-4" },
    ],
    { provider: "xai", id: "grok-4.6" },
  );
  expect(view.markdown).toContain("xai/grok-4.6");
  expect(view.markdown).toContain("当前");
  expect(view.buttons[0]).toMatchObject({
    action: "set_model",
    type: "primary",
    payload: { provider: "xai", modelId: "grok-4.6" },
  });
});

test("思考卡片当前档为 primary", () => {
  const view = formatThinkCard("high");
  expect(view.markdown).toContain("high");
  const high = view.buttons.find((b) => b.text === "high");
  expect(high?.action).toBe("set_think");
  expect(high?.type).toBe("primary");
  expect(high?.payload).toEqual({ level: "high" });
});

test("未分享 TUI 出开启按钮", () => {
  const view = formatHostList([
    { instanceId: "aaa", pid: 1, sessionName: "live", sharing: true },
    { pid: 2, sessionName: "idle", sharing: false },
  ]);
  expect(view.title).toBe("本机 TUI 2");
  expect(view.markdown).toContain("已分享");
  expect(view.markdown).toContain("未分享");
  expect(view.buttons.map((b) => b.text)).toEqual(["接入 #1", "开启 #2"]);
  expect(view.buttons[1]?.payload).toEqual({ instanceId: "2", selector: "2" });
});

test("空列表提示打开 TUI", () => {
  const view = formatHostList([]);
  expect(view.title).toBe("没有本机 TUI");
  expect(view.buttons).toEqual([]);
});
