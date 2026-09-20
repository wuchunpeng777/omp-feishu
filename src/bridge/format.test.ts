import { expect, test } from "bun:test";
import {
  extractNumberedChoices,
  formatHostList,
  formatModelList,
  formatSnapshot,
  formatThinkCard,
  uiChoices,
} from "./format.ts";
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

test("新一轮卡片不带上一轮输出", () => {
  const view = formatSnapshot(
    snap({
      state: { isStreaming: true, model: { provider: "x", id: "y" } },
      entries: [
        {
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "old" }] },
        },
        {
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "previous answer" }] },
        },
        {
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "new question" }] },
        },
      ],
    }),
    "omp",
    { showLeave: false },
  );
  expect(view.markdown).toContain("new question");
  expect(view.markdown).not.toContain("previous answer");
  expect(view.streaming).toBe(true);
});

test("本轮助手回复才进输出", () => {
  const view = formatSnapshot(
    snap({
      entries: [
        {
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "now" }] },
        },
        {
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "this turn" }] },
        },
      ],
    }),
    "omp",
    { showLeave: false },
  );
  expect(view.markdown).toContain("this turn");
});

test("select 选项变成可点按钮并退出流式", () => {
  const view = formatSnapshot(
    snap({
      state: { isStreaming: true, model: { provider: "x", id: "y" } },
      uiRequest: {
        reqId: "r1",
        method: "select",
        title: "选一个",
        options: ["方案A", { label: "方案B", value: "b" }],
      },
    }),
    "omp",
    { showLeave: false },
  );
  expect(view.streaming).toBe(false);
  expect(view.title.startsWith("待选择")).toBe(true);
  expect(view.notify).toBe("ask");
  expect(view.markdown).toContain("请选择");
  expect(view.buttons.filter((b) => b.action === "ui")).toEqual([
    {
      text: "方案A",
      action: "ui",
      type: "primary",
      payload: { reqId: "r1", value: "方案A" },
    },
    {
      text: "方案B",
      action: "ui",
      type: "primary",
      payload: { reqId: "r1", value: "b" },
    },
  ]);
});

test("正文编号选项变成 pick 按钮", () => {
  const view = formatSnapshot(
    snap({
      entries: [
        {
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "怎么做" }] },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "请选择：\n1. 方案甲\n2. 方案乙" }],
          },
        },
      ],
    }),
    "omp",
    { showLeave: false, showModelControls: true },
  );
  expect(view.buttons.filter((b) => b.action === "pick").map((b) => b.payload?.value)).toEqual([
    "方案甲",
    "方案乙",
  ]);
  expect(view.buttons.map((b) => b.action)).not.toContain("models");
});

test("uiChoices 解析对象选项", () => {
  expect(uiChoices({ method: "select", options: [{ text: "快", value: "fast" }] })).toEqual([
    { label: "快", value: "fast" },
  ]);
  expect(uiChoices({ method: "confirm" })).toEqual([
    { label: "确认", value: "确认" },
    { label: "取消", value: "取消" },
  ]);
});

test("extractNumberedChoices 要连续从 1 起", () => {
  expect(extractNumberedChoices("1. a\n2. b\n3. c")).toEqual(["a", "b", "c"]);
  expect(extractNumberedChoices("1. a\n3. c")).toEqual([]);
  expect(extractNumberedChoices("only one\n1. a")).toEqual([]);
});

