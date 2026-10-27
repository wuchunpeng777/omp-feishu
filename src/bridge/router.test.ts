import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bridge } from "./router.ts";
import type { AppConfig } from "../config.ts";
import type { FeishuApi, IncomingMessage } from "../feishu/bot.ts";
import type { CardView } from "./format.ts";
import { GroupStore } from "../rpc/groups.ts";
import { ChatStore, storePath } from "../rpc/store.ts";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "omp-router-"));
  const cards: Array<{ chatId: string; view: CardView }> = [];
  const texts: string[] = [];
  const created: string[] = [];
  const joined: string[] = [];
  const config: AppConfig = { appId: "app", appSecret: "secret", domain: "feishu",
    allowOpenIds: new Set(), ompBin: "omp", displayName: "飞书", cwd: "D:\\project", dataDir: dir };
  const api: FeishuApi = {
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
