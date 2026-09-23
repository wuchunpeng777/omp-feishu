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

test("卡片不展示过程区，子代理仍保留", () => {
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
      ],
      subagentProgress: [{ progress: { id: "s1", label: "explore", percent: 0.4 } }],
    }),
    "omp",
    { showLeave: false },
  );
  expect(view.markdown).not.toContain("**过程**");
  expect(view.markdown).not.toContain("`bash`");
  expect(view.markdown).toContain("explore 40%");
});

test("运行中标题显示已等待时长", () => {
  const view = formatSnapshot(
    snap({
      state: { isStreaming: true, model: { provider: "x", id: "y" } },
      turnStartedAt: 1_000,
    }),
    "omp",
    { showLeave: false, now: 66_000 },
  );
  expect(view.title).toBe("运行中 · 1:05");
  const hour = formatSnapshot(
    snap({
      state: { isStreaming: true, model: { provider: "x", id: "y" } },
      turnStartedAt: 1_000,
    }),
    "omp",
    { showLeave: false, now: 3_663_000 },
  );
  expect(hour.title).toBe("运行中 · 1:01:02");
  const idle = formatSnapshot(snap(), "omp", { showLeave: false });
  expect(idle.title).toBe("已接入 · omp");
});

test("快照未完成时运行中标题仍是时长", () => {
  const view = formatSnapshot(
    snap({
      status: "waiting",
      state: { isStreaming: true, model: { provider: "x", id: "y" } },
      turnStartedAt: 1_000,
      header: { title: "Fix 01 Trail Fragment Display", cwd: "/tmp" },
    }),
    "omp",
    { showLeave: false, now: 66_000 },
  );
  expect(view.title).toBe("运行中 · 1:05");
  expect(view.streaming).toBe(true);
});

test("主动离开是灰色已离开而不是错误", () => {
  const view = formatSnapshot(
    snap({
      status: "left",
      error: undefined,
      state: { isStreaming: false, model: { provider: "x", id: "y" } },
      header: { title: "Fix 01 Trail Fragment Display", cwd: "/tmp" },
    }),
    "Fix 01 Trail Fragment Display",
  );
  expect(view.title.startsWith("已离开")).toBe(true);
  expect(view.template).toBe("grey");
  expect(view.markdown).not.toContain("**断开**");
  expect(view.buttons.map((button) => button.action)).not.toContain("leave");
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

test("运行中但本轮还没回复时不画上一轮输出", () => {
  const view = formatSnapshot(
    snap({
      state: { isStreaming: true, model: { provider: "x", id: "y" } },
      streamingEnded: true,
      streamingMessage: {
        role: "assistant",
        content: [{ type: "text", text: "previous answer" }],
      },
      entries: [
        {
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "hi" }] },
        },
        {
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "previous answer" }] },
        },
      ],
    }),
    "omp",
    { showLeave: true },
  );
  expect(view.markdown).not.toContain("previous answer");
  expect(view.streaming).toBe(true);
  expect(view.title.startsWith("运行中")).toBe(true);
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
      text: "1. 方案A",
      action: "ui",
      type: "primary",
      width: "fill",
      payload: { reqId: "r1", value: "方案A" },
    },
    {
      text: "2. 方案B",
      action: "ui",
      type: "primary",
      width: "fill",
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

test("长选项通栏按钮，悬停看全文，payload 不截", () => {
  const long = "用 TypeScript 重写整个模块并补齐边界测试和文档";
  const view = formatSnapshot(
    snap({
      uiRequest: {
        reqId: "r2",
        method: "select",
        title: "选方案",
        options: [long, "短"],
      },
    }),
    "omp",
    { showLeave: false },
  );
  const ui = view.buttons.filter((b) => b.action === "ui");
  expect(ui[0]?.width).toBe("fill");
  expect(ui[0]?.payload?.value).toBe(long);
  expect(ui[0]?.text.startsWith("1. ")).toBe(true);
  expect(ui[0]?.text.length).toBeLessThanOrEqual(40);
  expect(ui[0]?.hoverTips).toContain(long);
  expect(view.markdown).toContain(long);
});

test("超长输出进全文区并保留结尾", () => {
  const output = `开头摘要。${"中".repeat(8000)}结论：选用方案乙。`;
  const view = formatSnapshot(
    snap({
      entries: [
        {
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "怎么做" }] },
        },
        {
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: output }] },
        },
      ],
    }),
    "omp",
    { showLeave: false },
  );
  expect(view.markdown).toContain("开头摘要");
  expect(view.overflow?.title).toBe("全文（已截断）");
  expect(view.overflow?.content).toContain("开头摘要");
  expect(view.overflow?.content).toContain("结论：选用方案乙。");
  expect(view.overflow?.content).toContain("中间省略");
});

test("运行中超长输出先留在正文，不提前出全文面板", () => {
  const output = `流${"式".repeat(2000)}中`;
  const view = formatSnapshot(
    snap({
      state: { isStreaming: true },
      streamingMessage: { role: "assistant", content: [{ type: "text", text: output }] },
      turnStartedAt: Date.now() - 1000,
    }),
    "omp",
    { showLeave: false },
  );
  expect(view.streaming).toBe(true);
  expect(view.overflow).toBeUndefined();
  expect(view.markdown).toContain("流");
});

