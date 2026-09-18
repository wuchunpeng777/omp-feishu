/** omp-feishu：飞书里用 omp（A）或挂本机 collab（B）。 */

import { Bridge } from "./bridge/router.ts";
import { formatSnapshot } from "./bridge/format.ts";
import { connectGuest } from "./collab/guest.ts";
import {
  fetchCollabLink,
  listCollabHosts,
  resolveHost,
  type CollabAccess,
} from "./collab/hosts.ts";
import { loadBotConfig, loadOmpConfig } from "./config.ts";
import { createFeishu } from "./feishu/bot.ts";
import { RpcSession } from "./rpc/session.ts";

process.on("unhandledRejection", (err) => {
  console.error("unhandledRejection", err);
});
process.on("uncaughtException", (err) => {
  console.error("uncaughtException", err);
});
const args = process.argv.slice(2);
const command = args[0];

if (command === "list") {
  const { ompBin } = loadOmpConfig();
  const hosts = await listCollabHosts(ompBin);
  if (hosts.length === 0) {
    console.log("本机没有 live collab。在 omp TUI 执行 /collab。");
    process.exit(0);
  }
  for (const [i, host] of hosts.entries()) {
    const name = host.sessionName || host.instanceId;
    console.log(
      `#${i + 1}  pid=${host.pid ?? "-"}  ${name}  ${host.cwd ?? ""}  ${host.model ?? ""}  ${host.access ?? ""}`,
    );
  }
} else if (command === "attach") {
  const { ompBin, displayName } = loadOmpConfig();
  const selector = args[1];
  const access: CollabAccess = args.includes("--view") ? "view" : "control";
  const hosts = await listCollabHosts(ompBin);
  if (hosts.length === 0) {
    console.error("本机没有 live collab");
    process.exit(1);
  }
  const host = selector ? resolveHost(hosts, selector) : hosts[0];
  if (!host) {
    console.error(`找不到会话：${selector}`);
    process.exit(1);
  }
  const link = await fetchCollabLink(host.instanceId, access, ompBin);
  console.error(`接入 ${host.sessionName || host.instanceId} (${access})`);
  const guest = connectGuest(link.url, displayName);
  guest.subscribe((snap) => {
    const view = formatSnapshot(snap, host.sessionName || host.instanceId);
    console.log(`\n--- ${view.title} ---\n${view.markdown}\n`);
  });
  if (access === "control") {
    await readStdinLines((text) => {
      if (text === "/abort") guest.sendAbort();
      else if (text === "/leave") {
        guest.close();
        process.exit(0);
      } else if (text) guest.sendPrompt(text);
    });
  } else {
    await Promise.withResolvers<void>().promise;
  }
} else if (command === "rpc") {
  const { ompBin, cwd } = loadOmpConfig();
  const session = await RpcSession.start({ ompBin, cwd });
  session.subscribe((snap) => {
    const view = formatSnapshot(snap, "omp", { showLeave: false });
    console.log(`\n--- ${view.title} ---\n${view.markdown}\n`);
  });
  console.error("标准输入一行一条 prompt，/abort 打断，/new 新开，Ctrl+C 退出");
  await readStdinLines(async (text) => {
    if (text === "/abort") session.abort();
    else if (text === "/new") await session.newSession();
    else if (text) {
      try {
        await session.prompt(text);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
      }
    }
  });
  await session.dispose();
} else if (command === "prompt") {
  const text = args.slice(1).join(" ").trim();
  if (!text) {
    console.error("用法：bun src/index.ts prompt <文字>");
    process.exit(1);
  }
  const { ompBin, cwd } = loadOmpConfig();
  const session = await RpcSession.start({ ompBin, cwd });
  try {
    await session.prompt(text);
    await session.waitUntilIdle();
    const view = formatSnapshot(session.snapshot(), "omp", { showLeave: false });
    console.log(`${view.title}\n${view.markdown}`);
  } finally {
    await session.dispose();
  }
} else {
  const config = loadBotConfig();
  const feishu = createFeishu(config);
  const bridge = new Bridge(config, feishu);
  console.log(`omp-feishu 长连接已启动（${config.domain}）`);
  await feishu.start(
    (msg) => bridge.onMessage(msg),
    (action) => bridge.onAction(action),
  );
}

async function readStdinLines(
  onLine: (text: string) => void | Promise<void>,
): Promise<void> {
  const decoder = new TextDecoder();
  const reader = Bun.stdin.stream().getReader();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value);
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const text = line.trim();
      if (text) await onLine(text);
    }
  }
}
