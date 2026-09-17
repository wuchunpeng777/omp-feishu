/** omp-feishu：飞书挂本机 collab 会话。 */

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
    const decoder = new TextDecoder();
    const reader = Bun.stdin.stream().getReader();
    let buf = "";
    console.error("标准输入一行一条 prompt，Ctrl+C 离开");
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const text = line.trim();
        if (text === "/abort") guest.sendAbort();
        else if (text === "/leave") {
          guest.close();
          process.exit(0);
        } else if (text) guest.sendPrompt(text);
      }
    }
  } else {
    await Promise.withResolvers<void>().promise;
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
