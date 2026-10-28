/** 持久保存机器人创建的会话群；与 RPC 状态分开，避免上下文更新覆盖群信息。 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FeishuDomain } from "../config.ts";
import type { CardView } from "../bridge/format.ts";

export type SessionGroup = {
  chatId: string;
  name: string;
  ownerOpenId: string;
  createdAt: string;
  requestId: string;
  closedAt?: string;
  collab?: { instanceId: string; access: "view" | "control" };
};

export class GroupStore {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}

  private async read(): Promise<SessionGroup[]> {
    try {
      const data = JSON.parse(await readFile(this.file, "utf8"));
      if (!Array.isArray(data.groups) || data.groups.some((g: SessionGroup) =>
        !g || [g.chatId, g.name, g.ownerOpenId, g.createdAt, g.requestId].some(v => typeof v !== "string" || !v)
      )) throw new Error("会话群记录格式错误，请先备份并检查 groups.json");
      return data.groups;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async list(ownerOpenId?: string): Promise<SessionGroup[]> {
    await this.chain;
    const groups = await this.read();
    return groups.filter(g => !g.closedAt && (!ownerOpenId || g.ownerOpenId === ownerOpenId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(chatId: string): Promise<SessionGroup | undefined> {
    await this.chain;
    return (await this.read()).find(g => g.chatId === chatId);
  }

  async findRequest(ownerOpenId: string, requestId: string): Promise<SessionGroup | undefined> {
    await this.chain;
    return (await this.read()).find(g => g.ownerOpenId === ownerOpenId && g.requestId === requestId);
  }

  async close(chatId: string): Promise<void> {
    const group = await this.get(chatId);
    if (group) await this.put({ ...group, closedAt: new Date().toISOString() });
  }

  async put(group: SessionGroup): Promise<void> {
    const operation = this.chain.then(async () => {
      const groups = await this.read();
      const index = groups.findIndex(g => g.chatId === group.chatId);
      if (index < 0) groups.push(group);
      else groups[index] = group;
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify({ groups }, null, 2) + "\n");
      await rename(temp, this.file);
    });
    this.chain = operation.catch(() => {});
    await operation;
  }
}

export function groupUrl(chatId: string, domain: FeishuDomain): string {
  const host = domain === "lark" ? "applink.larksuite.com" : "applink.feishu.cn";
  return `https://${host}/client/chat/open?openChatId=${encodeURIComponent(chatId)}`;
}

export function groupListCard(groups: SessionGroup[], page: number, domain: FeishuDomain): CardView {
  const pages = Math.max(1, Math.ceil(groups.length / 5));
  const current = Math.min(Math.max(1, page), pages);
  const selected = groups.slice((current - 1) * 5, current * 5);
  return {
    title: `我的 omp 会话 · ${groups.length} 个 · ${current}/${pages}`,
    template: "blue",
    markdown: selected.length
      ? selected.map((g, i) => `${(current - 1) * 5 + i + 1}. ${g.name.replace(/[\n\r*_\[\]<>`]/g, " ")}`).join("\n") + "\n\n点击打开对应群；退群后可点重新加入，关闭需二次确认。"
      : "还没有会话群。发送 /new 名称 创建，首次发消息时启动独立 omp 会话。",
    buttons: [
      ...selected.flatMap((g, i) => [
        { text: `打开 ${(current - 1) * 5 + i + 1}`, action: "open_group", url: groupUrl(g.chatId, domain) },
        { text: `重新加入 ${(current - 1) * 5 + i + 1}`, action: "join_group", payload: { groupId: g.chatId } },
        { text: `关闭 ${(current - 1) * 5 + i + 1}`, action: "close_group", type: "danger" as const, payload: { groupId: g.chatId } },
      ]),
      ...(current > 1 ? [{ text: "上一页", action: "groups", payload: { page: String(current - 1) } }] : []),
      ...(current < pages ? [{ text: "下一页", action: "groups", payload: { page: String(current + 1) } }] : []),
    ],
  };
}
