import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore, storePath } from "./store.ts";

test("写入后再读回 cwd 和 sessionFile", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-feishu-"));
  const file = storePath(dir);
  const store = new ChatStore(file);
  await store.set("oc_1", { cwd: "/tmp/demo", sessionFile: "/tmp/demo.jsonl" });
  const again = new ChatStore(file);
  expect(await again.get("oc_1")).toEqual({
    cwd: "/tmp/demo",
    sessionFile: "/tmp/demo.jsonl",
  });
  const raw = JSON.parse(await readFile(file, "utf8")) as {
    chats: Record<string, unknown>;
  };
  expect(raw.chats.oc_1).toBeDefined();
});
