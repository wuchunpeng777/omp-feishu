/** omp-feishu：飞书里用 omp（A）或挂本机 collab（B）。 */

import { Bridge } from "./bridge/router.ts";
import { formatSnapshot } from "./bridge/format.ts";
import { connectGuest } from "./collab/guest.ts";
import {
  ensureCollabHost,
  fetchCollabLink,
  listLiveConversations,
  resolveConversation,
  type CollabAccess,
} from "./collab/hosts.ts";
import { loadBotConfig, loadOmpConfig } from "./config.ts";
import { daemonDown, daemonStatus, daemonUp } from "./daemon.ts";
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
  const conversations = await listLiveConversations(ompBin);
  if (conversations.length === 0) {
    console.log("本机没有正在跑的 omp TUI。");
    process.exit(0);
  }
  for (const [i, conv] of conversations.entries()) {
    const name = conv.sessionName || conv.instanceId || `pid ${conv.pid ?? "?"}`;
    const share = conv.sharing ? "已分享" : "未分享";
    console.log(
      `#${i + 1}  pid=${conv.pid ?? "-"}  ${share}  ${name}  ${conv.cwd ?? ""}  ${conv.model ?? ""}  ${conv.access ?? ""}`,
    );
  }
} else if (command === "attach") {
  const { ompBin, displayName } = loadOmpConfig();
  const selector = args[1];
  const access: CollabAccess = args.includes("--view") ? "view" : "control";
  const conversations = await listLiveConversations(ompBin);
  if (conversations.length === 0) {
    console.error("本机没有正在跑的 omp TUI");
    process.exit(1);
  }
  const conversation = selector
    ? resolveConversation(conversations, selector)
    : conversations[0];
  if (!conversation) {
    console.error(`找不到会话：${selector}`);
    process.exit(1);
  }
  if (!conversation.sharing) {
    console.error(`正在为 pid ${conversation.pid ?? "?"} 开启 collab…`);
  }
  const host = await ensureCollabHost(conversation, ompBin);
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
} else if (command === "up") {
  await daemonUp(import.meta.path);
} else if (command === "down") {
  await daemonDown();
} else if (command === "running") {
  await daemonStatus();
} else {
  const config = loadBotConfig();
  const feishu = createFeishu(config);
  const bridge = new Bridge(config, feishu);
  console.log(`omp-feishu 长连接已启动（${config.domain}）`);
  console.log("前台进程，关终端会停。后台：bun run up");
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
