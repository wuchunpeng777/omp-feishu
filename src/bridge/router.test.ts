import { expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bridge } from "./router.ts";
import type { AppConfig } from "../config.ts";
import type { FeishuApi, IncomingMessage } from "../feishu/bot.ts";
import type { CardView } from "./format.ts";
import { GroupStore } from "../rpc/groups.ts";
import { ChatStore, storePath } from "../rpc/store.ts";
import * as hosts from "../collab/hosts.ts";
import { CollabGuest } from "../collab/guest.ts";
import { encodeBase64Url } from "../collab/crypto.ts";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "omp-router-"));
  const cards: Array<{ chatId: string; view: CardView }> = [];
  const texts: string[] = [];
  const created: string[] = [];
  const joined: string[] = [];
  const config: AppConfig = { appId: "app", appSecret: "secret", domain: "feishu",
    allowOpenIds: new Set(), ompBin: "omp", displayName: "飞书", cwd: "D:\\project", dataDir: dir };
  const api: FeishuApi = {
    dissolveSessionGroup: async () => {},
    createSessionGroup: async (name) => { created.push(name); return `oc_group_${created.length}`; },
    joinSessionGroup: async (chatId, openId) => { joined.push(`${chatId}:${openId}`); },
    sendCard: async (chatId, view) => { cards.push({ chatId, view }); return "om_card"; },
    replyCard: async () => undefined, patchCard: async () => true,
    pushLiveCard: async () => ({ sequence: 0, streaming: false, markdown: "", structure: "" }),
    sendText: async (_chatId, text) => { texts.push(text); },
    notifyDone: async () => {}, start: async () => {},
  };
  const message = (text: string, id = "om_1"): IncomingMessage => ({ chatId: "oc_private", messageId: id,
    chatType: "p2p", openId: "ou_me", text, mentioned: false });
  return { dir, api, config, message, cards, texts, created, joined, bridge: new Bridge(config, api) };
}

test("中文新建创建独立群，同一消息重试不重复建群，并继承目录", async () => {
  const f = await fixture();
  await new ChatStore(storePath(f.dir)).set("oc_private", { cwd: "D:\\other", sessionFile: "old.jsonl" });
  await Promise.all([f.bridge.onMessage(f.message("/新建 网站")), f.bridge.onMessage(f.message("/新建 网站"))]);
  await new Bridge(f.config, f.api).onMessage(f.message("/新建 网站"));
  expect(f.created).toEqual(["omp · 网站"]);
  const groups = await new GroupStore(join(f.dir, "groups.json")).list("ou_me");
  expect(groups).toHaveLength(1);
  expect(await new ChatStore(storePath(f.dir)).get(groups[0]!.chatId)).toEqual({ cwd: "D:\\other" });
  expect(f.cards.at(-1)?.view.buttons[0]?.url).toContain(groups[0]!.chatId);
  await f.bridge.onMessage(f.message("/new 第二个", "om_2"));
  expect(f.created).toHaveLength(2);
});

test("重启后列出全部自己的会话并能重新加入，其他用户不可加入", async () => {
  const f = await fixture();
  for (let i = 0; i < 7; i++) await f.bridge.onMessage(f.message(`/new 项目${i}`, `om_${i}`));
  const restarted = new Bridge(f.config, f.api);
  await restarted.onMessage(f.message("/chats"));
  expect(f.cards.at(-1)?.view.title).toContain("7 个 · 1/2");
  await restarted.onAction({ chatId: "oc_private", openId: "ou_me", action: "groups", payload: { page: "2" } });
  expect(f.cards.at(-1)?.view.title).toContain("2/2");
  await restarted.onAction({ chatId: "oc_private", openId: "ou_me", action: "join_group", payload: { groupId: "oc_group_1" } });
  expect(f.joined).toEqual(["oc_group_1:ou_me"]);
  await restarted.onMessage({ ...f.message("/sessions"), openId: "ou_other" });
  expect(f.cards.at(-1)?.view.title).toContain("0 个");
  await restarted.onAction({ chatId: "oc_private", openId: "ou_other", action: "join_group", payload: { groupId: "oc_group_1" } });
  expect(f.joined).toHaveLength(1);
  expect(f.texts.at(-1)).toContain("找不到你创建");
});

test("专用群免 @，普通群忽略未 @ 消息，非创建者不能操作专用群", async () => {
  const f = await fixture();
  await f.bridge.onMessage(f.message("/new 网站"));
  const prompts: string[] = [];
  // 用内存会话替代本机 omp，验证消息路由而不执行模型或工具。
  const internals = f.bridge as unknown as { ensureRpc: (chatId: string) => Promise<unknown> };
  internals.ensureRpc = async (chatId) => ({ liveGen: 0, session: {
    snapshot: () => ({}), prompt: async (text: string) => { prompts.push(`${chatId}:${text}`); },
  } });
  await f.bridge.onMessage({ ...f.message("你好"), chatType: "group", chatId: "oc_group_1" });
  await f.bridge.onMessage({ ...f.message("忽略"), chatType: "group", chatId: "oc_ordinary" });
  await f.bridge.onMessage({ ...f.message("拒绝"), chatType: "group", chatId: "oc_group_1", openId: "ou_other" });
  expect(prompts).toEqual(["oc_group_1:你好"]);
  expect(f.texts.at(-1)).toContain("只接受创建者");
});

test("创建 API 失败有反馈且不留下伪会话，白名单仍生效", async () => {
  const f = await fixture();
  f.api.createSessionGroup = async () => { throw new Error("缺少建群权限"); };
  await f.bridge.onMessage(f.message("/new 项目"));
  expect(f.texts.at(-1)).toContain("缺少建群权限");
  expect(await new GroupStore(join(f.dir, "groups.json")).list()).toHaveLength(0);
  f.config.allowOpenIds.add("ou_allowed");
  await f.bridge.onMessage(f.message("/new 项目"));
  expect(f.texts.at(-1)).toBe("你不在白名单里。");
});

test("缺少 open_id 时不能读取会话列表", async () => {
  const f = await fixture();
  await f.bridge.onMessage(f.message("/new 私有项目"));
  const count = f.cards.length;
  await f.bridge.onMessage({ ...f.message("/chats"), openId: "" });
  expect(f.cards).toHaveLength(count);
  expect(f.texts.at(-1)).toBe("你不在白名单里。");
});

test("reset 先解除 TUI 绑定，再重置当前窗口 RPC 并保存", async () => {
  const f = await fixture();
  let left = false;
  let reset = false;
  const state = f.bridge as unknown as { collab: Map<string, unknown>; rpc: Map<string, unknown> };
  state.collab.set("oc_private", { guest: { close: () => { left = true; } } });
  state.rpc.set("oc_private", { liveGen: 0, session: {
    snapshot: () => ({ status: "live" }), newSession: async () => { reset = true; },
    getCwd: () => "D:\\reset", getSessionFile: () => "new.jsonl",
  } });
  await f.bridge.onMessage(f.message("/reset"));
  expect(left).toBe(true);
  expect(reset).toBe(true);
  expect(state.collab.size).toBe(0);
  expect(await new ChatStore(storePath(f.dir)).get("oc_private")).toEqual({ cwd: "D:\\reset", sessionFile: "new.jsonl" });
});

test("关闭必须确认，可取消；确认后停止 RPC、解散群并保留本机历史索引", async () => {
  const f = await fixture();
  await f.bridge.onMessage(f.message("/new 网站"));
  const events: string[] = [];
  const state = f.bridge as unknown as { rpc: Map<string, unknown> };
  state.rpc.set("oc_group_1", { liveGen: 0, session: { abort: () => { events.push("abort"); }, dispose: async () => { events.push("dispose"); } } });
  await new ChatStore(storePath(f.dir)).set("oc_group_1", { cwd: "D:\\project", sessionFile: "history.jsonl" });
  f.api.dissolveSessionGroup = async (id) => { events.push(`delete:${id}`); };
  const msg = { ...f.message("/关闭"), chatId: "oc_group_1", chatType: "group" };
  await f.bridge.onMessage(msg);
  expect(events).toEqual([]);
  const first = f.cards.at(-1)!.view.buttons[0]!.payload!.token!;
  await f.bridge.onAction({ chatId: msg.chatId, openId: msg.openId, action: "close_cancel", payload: { token: first } });
  expect(events).toEqual([]);
  expect(f.texts.at(-1)).toContain("已取消");
  await f.bridge.onMessage(msg);
  const token = f.cards.at(-1)!.view.buttons[0]!.payload!.token!;
  const action = { chatId: msg.chatId, openId: msg.openId, action: "close_confirm", payload: { token } };
  await Promise.all([f.bridge.onAction(action), f.bridge.onAction(action)]);
  expect(events).toEqual(["abort", "dispose", "delete:oc_group_1"]);
  expect(state.rpc.size).toBe(0);
  const store = new GroupStore(join(f.dir, "groups.json"));
  expect(await store.list()).toHaveLength(0);
  expect((await store.get(msg.chatId))?.closedAt).toBeDefined();
  expect((await new ChatStore(storePath(f.dir)).get(msg.chatId))?.sessionFile).toBe("history.jsonl");
  const restarted = new Bridge(f.config, f.api);
  const count = f.texts.length;
  await restarted.onMessage({ ...msg, text: "迟到的普通文字" });
  expect(f.texts).toHaveLength(count);
  await restarted.onMessage(f.message("/new 网站"));
  expect(f.created).toHaveLength(1);
});

test("列表关闭可从私聊操作；解散群失败保留列表并允许重新确认", async () => {
  const f = await fixture();
  await f.bridge.onMessage(f.message("/new 网站"));
  await f.bridge.onMessage(f.message("/chats"));
  const button = f.cards.at(-1)!.view.buttons.find(b => b.action === "close_group")!;
  let attempts = 0;
  f.api.dissolveSessionGroup = async () => { if (++attempts === 1) throw new Error("缺少 im:chat:delete"); };
  const start = { chatId: "oc_private", openId: "ou_me", action: button.action, payload: button.payload! };
  await f.bridge.onAction(start);
  let token = f.cards.at(-1)!.view.buttons[0]!.payload!.token!;
  await f.bridge.onAction({ ...start, action: "close_confirm", payload: { token } });
  expect((await new GroupStore(join(f.dir, "groups.json")).list()).length).toBe(1);
  expect(f.texts.at(-1)).toContain("缺少 im:chat:delete");
  await f.bridge.onAction(start);
  token = f.cards.at(-1)!.view.buttons[0]!.payload!.token!;
  await f.bridge.onAction({ ...start, action: "close_confirm", payload: { token } });
  expect(attempts).toBe(2);
  expect(await new GroupStore(join(f.dir, "groups.json")).list()).toHaveLength(0);
  expect(f.texts.at(-1)).toContain("群已解散");
});

test("普通群、私聊和非创建者不能解散群，确认令牌不能跨窗口使用", async () => {
  const f = await fixture();
  let deleted = 0;
  f.api.dissolveSessionGroup = async () => { deleted++; };
  await f.bridge.onMessage(f.message("/close"));
  expect(f.texts.at(-1)).toContain("只能关闭自己");
  await f.bridge.onMessage({ ...f.message("/close"), chatId: "oc_ordinary", chatType: "group" });
  expect(f.texts.at(-1)).toContain("只能关闭自己");
  await f.bridge.onMessage(f.message("/new 网站"));
  await f.bridge.onAction({ chatId: "oc_private", openId: "ou_other", action: "close_group", payload: { groupId: "oc_group_1" } });
  expect(f.texts.at(-1)).toContain("只能关闭自己");
  await f.bridge.onAction({ chatId: "oc_private", openId: "ou_me", action: "close_group", payload: { groupId: "oc_group_1" } });
  const token = f.cards.at(-1)!.view.buttons[0]!.payload!.token!;
  await f.bridge.onAction({ chatId: "oc_other", openId: "ou_me", action: "close_confirm", payload: { token } });
  await f.bridge.onAction({ chatId: "oc_private", openId: "ou_other", action: "close_confirm", payload: { token } });
  expect(deleted).toBe(0);
});

test("过期和已取消的确认按钮不会关闭群", async () => {
  const f = await fixture();
  await f.bridge.onMessage(f.message("/new 网站"));
  const start = { chatId: "oc_private", openId: "ou_me", action: "close_group", payload: { groupId: "oc_group_1" } };
  let deleted = 0;
  f.api.dissolveSessionGroup = async () => { deleted++; };
  await f.bridge.onAction(start);
  const token = f.cards.at(-1)!.view.buttons[0]!.payload!.token!;
  const internals = f.bridge as unknown as { closeRequests: Map<string, { expiresAt: number }> };
  internals.closeRequests.get(token)!.expiresAt = Date.now() - 1;
  await f.bridge.onAction({ ...start, action: "close_confirm", payload: { token } });
  expect(deleted).toBe(0);
  expect(f.texts.at(-1)).toContain("确认已失效");
  await f.bridge.onAction(start);
  const canceled = f.cards.at(-1)!.view.buttons[0]!.payload!.token!;
  await f.bridge.onAction({ ...start, action: "close_cancel", payload: { token: canceled } });
  await f.bridge.onAction({ ...start, action: "close_confirm", payload: { token: canceled } });
  expect(deleted).toBe(0);
});

test("关闭时只断开 collab，不终止共享 TUI；等待正在启动的 RPC", async () => {
  const f = await fixture();
  await f.bridge.onMessage(f.message("/new 网站"));
  const events: string[] = [];
  const internals = f.bridge as unknown as {
    collab: Map<string, unknown>; rpc: Map<string, unknown>; startingRpc: Map<string, Promise<unknown>>;
  };
  internals.collab.set("oc_group_1", { guest: { close: () => { events.push("leave"); } } });
  const ready = Promise.withResolvers<unknown>();
  internals.startingRpc.set("oc_group_1", ready.promise);
  f.api.dissolveSessionGroup = async () => { events.push("delete"); };
  const start = { chatId: "oc_private", openId: "ou_me", action: "close_group", payload: { groupId: "oc_group_1" } };
  await f.bridge.onAction(start);
  const token = f.cards.at(-1)!.view.buttons[0]!.payload!.token!;
  const completion = f.bridge.onAction({ ...start, action: "close_confirm", payload: { token } });
  // 下一次事件循环后关闭应阻塞在 RPC 启动上，不能提前解散群。
  await Bun.sleep(5);
  expect(events).toEqual([]);
  internals.rpc.set("oc_group_1", { session: { dispose: async () => { events.push("dispose"); } } });
  ready.resolve({});
  await completion;
  expect(events).toEqual(["leave", "dispose", "delete"]);
});

test("目录点选只重建当前会话，移除旧上下文并持久保存目录", async () => {
  const f = await fixture();
  const target = join(f.dir, "project with spaces");
  await mkdir(target);
  await writeFile(join(f.dir, "cwd-presets.json"), JSON.stringify([{ name: "项目", path: target }]));
  const store = new ChatStore(storePath(f.dir));
  await store.set("oc_private", { cwd: f.dir, sessionFile: "old.jsonl" });
  await store.set("oc_other", { cwd: f.dir, sessionFile: "other.jsonl" });
  let disposed = false;
  const state = f.bridge as unknown as {
    ensureRpc: (chatId: string) => Promise<unknown>; rpc: Map<string, unknown>;
  };
  state.rpc.set("oc_private", { session: { dispose: async () => { disposed = true; } } });
  state.ensureRpc = async () => ({});
  await f.bridge.onMessage(f.message("/cwd"));
  const button = f.cards.at(-1)!.view.buttons[0]!;
  await f.bridge.onAction({ chatId: "oc_private", openId: "ou_me", action: button.action, payload: button.payload! });
  const restarted = new ChatStore(storePath(f.dir));
  expect(disposed).toBe(true);
  expect(await restarted.get("oc_private")).toEqual({ cwd: target });
  expect(await restarted.get("oc_other")).toEqual({ cwd: f.dir, sessionFile: "other.jsonl" });
});

test("过期目录按钮不能切到新条目，不存在的目录不停止原会话", async () => {
  const f = await fixture();
  const file = join(f.dir, "cwd-presets.json");
  await writeFile(file, JSON.stringify([{ name: "项目", path: f.dir }]));
  await new ChatStore(storePath(f.dir)).set("oc_private", { cwd: f.dir, sessionFile: "keep.jsonl" });
  const state = f.bridge as unknown as { rpc: Map<string, unknown> };
  let disposed = false;
  state.rpc.set("oc_private", { session: { dispose: async () => { disposed = true; } } });
  await f.bridge.onMessage(f.message("/cwd"));
  const button = f.cards.at(-1)!.view.buttons[0]!;
  await writeFile(file, JSON.stringify([{ name: "新项目", path: join(f.dir, "missing") }]));
  await f.bridge.onAction({ chatId: "oc_private", openId: "ou_me", action: button.action, payload: button.payload! });
  expect(f.texts.at(-1)).toContain("常用目录已变更");
  await f.bridge.onMessage(f.message("/cwd"));
  const missing = f.cards.at(-1)!.view.buttons[0]!;
  await f.bridge.onAction({ chatId: "oc_private", openId: "ou_me", action: missing.action, payload: missing.payload! });
  expect(disposed).toBe(false);
  expect(await new ChatStore(storePath(f.dir)).get("oc_private")).toEqual({ cwd: f.dir, sessionFile: "keep.jsonl" });
  await writeFile(file, "{bad json");
  await f.bridge.onMessage(f.message("/cwd"));
  expect(disposed).toBe(false);
  expect(await new ChatStore(storePath(f.dir)).get("oc_private")).toEqual({ cwd: f.dir, sessionFile: "keep.jsonl" });
});

test("目录点选遵循群创建者权限且不能改变接入中的电脑TUI", async () => {
  const f = await fixture();
  await f.bridge.onMessage(f.message("/new 项目"));
  await writeFile(join(f.dir, "cwd-presets.json"), JSON.stringify([{ name: "项目", path: f.dir }]));
  await f.bridge.onMessage({ ...f.message("/cwd"), chatId: "oc_group_1", chatType: "group" });
  const button = f.cards.at(-1)!.view.buttons[0]!;
  await f.bridge.onAction({ chatId: "oc_group_1", openId: "ou_other", action: button.action, payload: button.payload! });
  expect(await new ChatStore(storePath(f.dir)).get("oc_group_1")).toEqual({ cwd: f.config.cwd });
  const state = f.bridge as unknown as { collab: Map<string, unknown> };
  state.collab.set("oc_group_1", {});
  await f.bridge.onAction({ chatId: "oc_group_1", openId: "ou_me", action: button.action, payload: button.payload! });
  expect(f.texts.at(-1)).toContain("/leave");
  expect(await new ChatStore(storePath(f.dir)).get("oc_group_1")).toEqual({ cwd: f.config.cwd });
});

async function collabFixture() {
  const f = await fixture();
  const host = { instanceId: "tui_fixture_1234", sessionName: "电脑项目", cwd: f.dir, sharing: true };
  const list = spyOn(hosts, "listLiveConversations").mockResolvedValue([host]);
  const ensure = spyOn(hosts, "ensureCollabHost").mockResolvedValue(host);
  const secret = encodeBase64Url(new Uint8Array(48).fill(1));
  const link = spyOn(hosts, "fetchCollabLink").mockResolvedValue({
    instanceId: host.instanceId, access: "control", url: `ws://127.0.0.1:1/r/tui_fixture_1234.${secret}`,
  });
  const connect = spyOn(CollabGuest.prototype, "connect").mockImplementation(function(this: CollabGuest) {
    // 仅替换网络握手；状态归约和后续消息路由仍使用真实 CollabGuest。
    const guest = this as unknown as { apply(frame: unknown): void };
    guest.apply({
      t: "welcome", entryCount: 0, state: { isStreaming: false }, agents: [], readOnly: false,
    });
  });
  const bridges = [f.bridge];
  const state = (bridge: Bridge) => bridge as unknown as {
    collab: Map<string, { guest: CollabGuest }>;
    leaveCollab(chatId: string, notify: boolean, forget: boolean): Promise<void>;
  };
  const restart = async () => {
    const previous = bridges.at(-1)!;
    for (const id of state(previous).collab.keys()) await state(previous).leaveCollab(id, false, false);
    const next = new Bridge(f.config, f.api);
    bridges.push(next);
    return next;
  };
  const dispose = async () => {
    for (const bridge of bridges) {
      for (const id of state(bridge).collab.keys()) await state(bridge).leaveCollab(id, false, false);
    }
    connect.mockRestore(); link.mockRestore(); ensure.mockRestore(); list.mockRestore();
  };
  return { ...f, host, list, state, restart, dispose };
}

test("公共窗口接入创建独立群，并发点击复用；消息、输出与所有者隔离", async () => {
  const f = await collabFixture();
  try {
    const action = { chatId: "oc_private", openId: "ou_me", action: "attach", payload: { selector: f.host.instanceId } };
    await Promise.all([f.bridge.onAction(action), f.bridge.onAction(action)]);
    expect(f.created).toEqual(["omp · 电脑项目"]);
    expect([...f.state(f.bridge).collab.keys()]).toEqual(["oc_group_1"]);
    expect(f.cards.at(-1)?.view.buttons[0]?.url).toContain("oc_group_1");
    const message = { ...f.message("独立窗口的指令"), chatType: "group", chatId: "oc_group_1" };
    await f.bridge.onMessage({ ...message, openId: "ou_other" });
    const guest = f.state(f.bridge).collab.get("oc_group_1")!.guest;
    expect(guest.snapshot().entries).toEqual([]);
    await f.bridge.onMessage(message);
    expect(guest.snapshot().entries).toEqual([
      { type: "message", message: { role: "user", content: [{ type: "text", text: message.text }] } },
    ]);
    const streamed: string[] = [];
    const flushed = Promise.withResolvers<void>();
    f.api.pushLiveCard = async (chatId) => {
      streamed.push(chatId); flushed.resolve();
      return { sequence: 0, streaming: false, markdown: "", structure: "" };
    };
    await flushed.promise;
    expect(streamed).toEqual(["oc_group_1"]);
    await f.bridge.onMessage({ ...f.message("/attach 1"), openId: "ou_other" });
    expect(f.created).toHaveLength(2);
    expect((await new GroupStore(join(f.dir, "groups.json")).list("ou_other"))[0]?.chatId).toBe("oc_group_2");
  } finally { await f.dispose(); }
});

test("接入群重启后复用并恢复 TUI；离开清除绑定；专用群内接入不另建群", async () => {
  const f = await collabFixture();
  try {
    await f.bridge.onMessage(f.message("/view 1"));
    let restarted = await f.restart();
    await restarted.onMessage(f.message("/view 1"));
    expect(f.created).toHaveLength(1);
    expect(f.joined).toEqual(["oc_group_1:ou_me"]);
    restarted = await f.restart();
    const message = { ...f.message("只读不能写入"), chatType: "group", chatId: "oc_group_1" };
    await restarted.onMessage(message);
    expect(f.state(restarted).collab.get(message.chatId)?.guest.snapshot().entries).toEqual([]);
    expect(f.texts.at(-1)).toContain("只读接入");
    await restarted.onMessage({ ...message, text: "/attach 1" });
    expect(f.created).toHaveLength(1);
    await restarted.onMessage({ ...message, text: "切成控制后写入" });
    expect(f.state(restarted).collab.get(message.chatId)?.guest.snapshot().entries[0]?.message?.content)
      .toEqual([{ type: "text", text: "切成控制后写入" }]);
    await restarted.onMessage({ ...message, text: "/leave" });
    expect((await new GroupStore(join(f.dir, "groups.json")).get(message.chatId))?.collab).toBeUndefined();
    expect(f.state(restarted).collab.size).toBe(0);
  } finally { await f.dispose(); }
});

test("接入建群权限失败不回退公共窗口；重启后主机离线不启动 RPC", async () => {
  const f = await collabFixture();
  try {
    const create = f.api.createSessionGroup;
    f.api.createSessionGroup = async () => { throw new Error("缺少建群权限"); };
    await f.bridge.onMessage(f.message("/attach 1"));
    expect(f.texts.at(-1)).toContain("缺少建群权限");
    expect(f.state(f.bridge).collab.size).toBe(0);
    expect(await new GroupStore(join(f.dir, "groups.json")).list()).toEqual([]);
    f.api.createSessionGroup = create;
    await f.bridge.onMessage(f.message("/attach 1"));
    const restarted = await f.restart();
    f.list.mockResolvedValue([]);
    let rpcStarted = false;
    // 测试边界：观察离线恢复是否错误进入 RPC 分支。
    const internals = restarted as unknown as { ensureRpc(): Promise<unknown> };
    internals.ensureRpc = async () => {
      rpcStarted = true; throw new Error("不能启动");
    };
    await restarted.onMessage({ ...f.message("发给电脑"), chatType: "group", chatId: "oc_group_1" });
    expect(rpcStarted).toBe(false);
    expect(f.state(restarted).collab.size).toBe(0);
    expect((await new GroupStore(join(f.dir, "groups.json")).get("oc_group_1"))?.collab?.instanceId)
      .toBe(f.host.instanceId);
  } finally { await f.dispose(); }
});
