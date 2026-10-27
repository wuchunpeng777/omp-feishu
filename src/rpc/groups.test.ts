import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GroupStore, groupListCard, groupUrl, type SessionGroup } from "./groups.ts";
import { buildCard, buildCardV2 } from "../feishu/cards.ts";

function record(n: number, owner = "ou_me"): SessionGroup {
  return { chatId: `oc_${n}`, name: `omp · ${n}`, ownerOpenId: owner,
    createdAt: new Date(1700000000000 + n).toISOString(), requestId: `req_${n}` };
}

test("会话群并发写入不丢记录，重启后按所有者过滤", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-groups-"));
  const file = join(dir, "groups.json");
  const store = new GroupStore(file);
  await Promise.all(Array.from({ length: 12 }, (_, i) => store.put(record(i, i === 0 ? "ou_other" : "ou_me"))));
  const again = new GroupStore(file);
  expect((await again.list()).length).toBe(12);
  expect((await again.list("ou_me")).length).toBe(11);
  expect((await again.list("ou_me"))[0]?.chatId).toBe("oc_11");
  await again.put({ ...record(2), name: "更新名称" });
  expect((await again.list()).length).toBe(12);
  expect((await again.get("oc_2"))?.name).toBe("更新名称");
});

test("损坏记录会报错，不能静默覆盖已有群列表", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-groups-"));
  const file = join(dir, "groups.json");
  await writeFile(file, "{broken");
  await expect(new GroupStore(file).put(record(1))).rejects.toThrow();
});

test("分页可以访问全部会话，URL 按飞书和 Lark 区分", () => {
  const groups = Array.from({ length: 13 }, (_, i) => record(i));
  const first = groupListCard(groups, 1, "feishu");
  const last = groupListCard(groups, 999, "lark");
  expect(first.title).toContain("1/3");
  expect(first.buttons.some(b => b.text === "下一页")).toBe(true);
  expect(last.title).toContain("3/3");
  expect(last.buttons.filter(b => b.url)).toHaveLength(3);
  expect(last.buttons.some(b => b.text === "下一页")).toBe(false);
  expect(last.buttons[0]?.url).toContain("applink.larksuite.com");
  expect(groupUrl("oc_a&b", "feishu")).toContain("oc_a%26b");
  expect(groupListCard([], 1, "feishu").markdown).toContain("/new");
});

test("列表同时生成跳转和加入按钮，旧卡片每个容器不超过五个按钮", () => {
  const view = groupListCard(Array.from({ length: 6 }, (_, i) => record(i)), 1, "feishu");
  const old = buildCard(view) as { elements: Array<{ tag: string; actions?: Array<Record<string, unknown>> }> };
  const actions = old.elements.filter(e => e.tag === "action");
  expect(actions.length).toBeGreaterThan(1);
  expect(actions.every(e => e.actions!.length <= 5)).toBe(true);
  expect(actions[0]?.actions?.[0]?.url).toContain("openChatId=oc_0");
  const next = buildCardV2(view) as { body: { elements: Array<{ tag: string; behaviors?: Array<{ type: string }> }> } };
  const buttons = next.body.elements.filter(e => e.tag === "button");
  expect(buttons[0]?.behaviors?.[0]?.type).toBe("open_url");
  expect(buttons[1]?.behaviors?.[0]?.type).toBe("callback");
});
