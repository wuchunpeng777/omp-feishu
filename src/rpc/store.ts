/** 飞书 chat → omp rpc 会话文件 / cwd。 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type ChatPersist = {
  cwd: string;
  sessionFile?: string;
};

export class ChatStore {
  private records: Record<string, ChatPersist> = {};
  private loaded = false;

  constructor(private readonly file: string) {}

  async get(chatId: string): Promise<ChatPersist | undefined> {
    await this.ensure();
    return this.records[chatId];
  }

  async set(chatId: string, rec: ChatPersist): Promise<void> {
    await this.ensure();
    this.records[chatId] = rec;
    await this.flush();
  }

  private async ensure(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as { chats?: Record<string, ChatPersist> };
      this.records = parsed.chats ?? {};
    } catch {
      this.records = {};
    }
    this.loaded = true;
  }

  private async flush(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ chats: this.records }, null, 2)}\n`);
    await rename(tmp, this.file);
  }
}

export function storePath(dataDir: string): string {
  return join(dataDir, "chats.json");
}
