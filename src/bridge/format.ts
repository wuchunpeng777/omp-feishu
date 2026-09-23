/** 把 collab 快照压成飞书卡片可读的流程摘要。 */

import type { AgentMessage, GuestSnapshot, SessionEntry } from "../collab/types.ts";
import {
  modelRef,
  THINK_LEVELS,
  type ModelPick,
} from "./select.ts";

export type CardButton = {
  text: string;
  action: string;
  type?: "primary" | "danger" | "default";
  payload?: Record<string, string>;
  width?: "fill";
  hoverTips?: string;
};

export type CardView = {
  title: string;
  template: "blue" | "green" | "orange" | "red" | "grey" | "indigo";
  markdown: string;
  buttons: CardButton[];
  streaming?: boolean;
  notify?: "done" | "ask";
  overflow?: { title: string; content: string };
};

export type FormatSnapshotOpts = {
  showLeave?: boolean;
  showModelControls?: boolean;
  now?: number;
};

/** 飞书卡片 JSON 约 30KB。中文按 3 字节估，正文+全文合计压在 ~8k 字内。 */
const MAX_MD = 6000;
const OUTPUT_STREAM = 4000;
const OUTPUT_PREVIEW = 1200;
const OUTPUT_OVERFLOW = 5000;
const BTN_TEXT = 40;
const HOVER_TEXT = 200;
const OPTION_VALUE = 400;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/** 超长时留头尾，避免只看见开头、结论被裁掉。 */
function clipKeepEnds(text: string, max: number): string {
  if (text.length <= max) return text;
  const mark = "\n\n…(中间省略)…\n\n";
  const budget = max - mark.length;
  if (budget < 32) return truncate(text, max);
  const head = Math.max(16, Math.floor(budget * 0.35));
  return `${text.slice(0, head)}${mark}${text.slice(-(budget - head))}`;
}

function choiceButton(
  index: number,
  label: string,
  action: string,
  payload: Record<string, string>,
): CardButton {
  const full = `${index + 1}. ${label}`;
  const text = truncate(full, BTN_TEXT);
  const button: CardButton = {
    text,
    action,
    type: "primary",
    width: "fill",
    payload,
  };
  if (full !== text || label.length > 16) {
    button.hoverTips = truncate(full, HOVER_TEXT);
  }
  return button;
}

function modelLabel(state: GuestSnapshot["state"]): string {
  const model = state?.model;
  if (!model) return "";
  if (typeof model === "string") return model;
  if (model.provider && model.id) return `${model.provider}/${model.id}`;
  return model.name ?? model.id ?? "";
}

function blocksText(content: unknown, type: string): string {
  if (typeof content === "string") return type === "text" ? content : "";
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const rec = block as { type?: string; text?: string };
    if (rec.type === type && typeof rec.text === "string") parts.push(rec.text);
  }
  return parts.join("");
}

function messageText(message: AgentMessage | undefined): string {
  if (!message) return "";
  return blocksText(message.content, "text").trim();
}

function thinkingText(message: AgentMessage | undefined): string {
  if (!message) return "";
  return blocksText(message.content, "thinking").trim();
}

function lastOfRole(entries: SessionEntry[], role: string): AgentMessage | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === "message" && entry.message?.role === role) {
      return entry.message;
    }
  }
  return undefined;
}

/** 只取本轮（最后一条用户消息之后）的助手回复，避免新卡片先画出上一轮。 */
function lastAssistantThisTurn(entries: SessionEntry[]): AgentMessage | undefined {
  let lastUser = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === "message" && entry.message?.role === "user") {
      lastUser = i;
      break;
    }
  }
  for (let i = entries.length - 1; i > lastUser; i--) {
    const entry = entries[i];
    if (entry?.type === "message" && entry.message?.role === "assistant") {
      return entry.message;
    }
  }
  return undefined;
}

export type UiChoice = { label: string; value: string };

export function uiChoices(req: { method?: string; options?: unknown } | undefined): UiChoice[] {
  if (!req) return [];
  if (!Array.isArray(req.options)) {
    return req.method === "confirm"
      ? [
          { label: "确认", value: "确认" },
          { label: "取消", value: "取消" },
        ]
      : [];
  }
  const out: UiChoice[] = [];
  for (const item of req.options) {
    if (typeof item === "string" && item.trim()) {
      out.push({ label: item.trim(), value: item.trim() });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const labelRaw = rec.label ?? rec.text ?? rec.title ?? rec.value;
    const valueRaw = rec.value ?? rec.label ?? rec.text ?? rec.title;
    const label = typeof labelRaw === "string" ? labelRaw.trim() : "";
    const value = typeof valueRaw === "string" ? valueRaw.trim() : "";
    if (label || value) out.push({ label: label || value, value: value || label });
  }
  return out;
}

/** 从正文抽出 1. 2. 这种选项，供卡片按钮点选。 */
export function extractNumberedChoices(text: string): string[] {
  const items = new Map<number, string>();
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(\d+)[.)、]\s+(\S.*)$/);
    if (!match) continue;
    const n = Number(match[1]);
    const body = match[2].trim();
    if (n >= 1 && n <= 8 && body) {
      items.set(n, body.length <= OPTION_VALUE ? body : body.slice(0, OPTION_VALUE));
    }
  }
  if (items.size < 2) return [];
  const out: string[] = [];
  for (let i = 1; i <= items.size; i++) {
    const item = items.get(i);
    if (!item) return [];
    out.push(item);
  }
  return out.length >= 2 && out.length <= 8 ? out : [];
}

function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

export function formatSnapshot(
  snap: GuestSnapshot,
  hostLabel: string,
  opts?: FormatSnapshotOpts,
): CardView {
  const asking = Boolean(snap.uiRequest);
  const streaming = snap.state?.isStreaming === true && !asking;
  const status = snap.error
    ? "错误"
    : asking
      ? "待选择"
      : streaming
        ? "运行中"
        : snap.status === "live"
          ? "已接入"
          : snap.status === "left"
            ? "已离开"
            : snap.status === "waiting"
              ? "等待主机"
              : snap.status === "reconnecting"
                ? "重连中"
                : snap.status === "connecting"
                  ? "连接中"
                  : "已断开";

  const template: CardView["template"] = snap.error
    ? "red"
    : asking
      ? "indigo"
      : streaming
        ? "orange"
        : snap.status === "live"
          ? "green"
          : snap.status === "ended" || snap.status === "left"
            ? "grey"
            : "blue";

  const cwd = typeof snap.header?.cwd === "string" ? snap.header.cwd : "";
  const titleName =
    (typeof snap.header?.title === "string" && snap.header.title) || hostLabel;
  const elapsed =
    streaming && snap.turnStartedAt
      ? formatElapsed((opts?.now ?? Date.now()) - snap.turnStartedAt)
      : "";
  const title = elapsed
    ? `${status} · ${elapsed}`
    : `${status} · ${truncate(titleName, 24)}`;

  const lines: string[] = [];
  lines.push(`**会话** ${hostLabel}${snap.readOnly ? " · 只读" : ""}`);
  if (cwd) lines.push(`**目录** \`${truncate(cwd, 80)}\``);
  const model = modelLabel(snap.state);
  if (model) {
    const think = snap.state?.thinkingLevel
      ? ` · think ${snap.state.thinkingLevel}`
      : "";
    lines.push(`**模型** ${model}${think}`);
  }
  const percent = snap.state?.context?.percent;
  if (typeof percent === "number") {
    lines.push(`**上下文** ${(percent * 100).toFixed(1)}%`);
  }

  const lastUser = lastOfRole(snap.entries, "user");
  const userText = messageText(lastUser);
  if (userText) lines.push(`\n**最近指令**\n${truncate(userText, 400)}`);

  const live = snap.streamingMessage;
  let liveText = messageText(live);
  const thisTurnText = messageText(lastAssistantThisTurn(snap.entries));
  if (!thisTurnText) {
    const prevText = messageText(lastOfRole(snap.entries, "assistant"));
    if (liveText && liveText === prevText) liveText = "";
  }
  const lastEntry = snap.entries[snap.entries.length - 1];
  if (
    streaming &&
    lastEntry?.type === "message" &&
    lastEntry.message?.role === "assistant" &&
    liveText === messageText(lastEntry.message)
  ) {
    liveText = "";
  }
  const output = liveText || (streaming ? "" : thisTurnText);

  if (snap.subagentLifecycle.length > 0 || snap.subagentProgress.length > 0) {
    lines.push("\n**子代理**");
    for (const agent of snap.subagentLifecycle.slice(-8)) {
      const name = agent.name ?? agent.agent ?? agent.id;
      const st = agent.status ?? "";
      lines.push(`- ${name}${st ? ` · ${st}` : ""}`);
    }
    for (const item of snap.subagentProgress.slice(-8)) {
      const p = item.progress;
      if (!p) continue;
      const label = p.label ?? p.id ?? "subagent";
      const pct =
        typeof p.percent === "number"
          ? p.percent <= 1
            ? ` ${(p.percent * 100).toFixed(0)}%`
            : ` ${p.percent.toFixed(0)}%`
          : "";
      lines.push(`- ${label}${pct}`);
    }
  }

  const thinking = thinkingText(live);
  if (thinking) {
    lines.push(`\n**思考**\n${truncate(thinking, 800)}`);
  }
  let overflow: CardView["overflow"];
  if (output) {
    if (!streaming && output.length > OUTPUT_PREVIEW) {
      lines.push(`\n**输出**\n${output.slice(0, OUTPUT_PREVIEW)}…`);
      const full = clipKeepEnds(output, OUTPUT_OVERFLOW);
      overflow = {
        title: full.length < output.length ? "全文（已截断）" : "全文",
        content:
          full.length < output.length
            ? `${full}\n\n_已截断，完整内容在 omp 会话。_`
            : full,
      };
    } else {
      const capLen = streaming ? OUTPUT_STREAM : OUTPUT_PREVIEW;
      lines.push(`\n**输出**\n${truncate(output, capLen)}`);
    }
  }

  const choices = uiChoices(snap.uiRequest);
  if (snap.uiRequest) {
    const req = snap.uiRequest;
    const heading =
      req.method === "confirm" ? "确认" : req.method === "select" ? "请选择" : "询问";
    lines.push(`\n**${heading}** ${req.title ?? req.method ?? ""}`.trimEnd());
    if (req.message) lines.push(String(req.message));
    if (choices.length > 0) {
      for (const [i, choice] of choices.entries()) {
        const detail = req.optionDetails?.[i]?.description;
        lines.push(`${i + 1}. ${choice.label}${detail ? ` — ${detail}` : ""}`);
      }
    } else if (req.method === "input" || req.method === "editor") {
      lines.push("请直接回复文字。");
    }
  }

  if (snap.notices.length > 0) {
    lines.push("");
    for (const notice of snap.notices.slice(-3)) {
      lines.push(`_${notice.level}: ${truncate(notice.message, 200)}_`);
    }
  }

  if (snap.error) {
    const label = snap.status === "ended" ? "断开" : "错误";
    lines.push(`\n**${label}** ${snap.error}`);
  }

  const picks =
    !asking && !streaming && !snap.readOnly ? extractNumberedChoices(output) : [];

  const buttons: CardButton[] = [];
  if (!snap.readOnly && snap.status === "live") {
    buttons.push({ text: "打断", action: "abort", type: "danger" });
  }
  if (
    opts?.showModelControls &&
    !snap.readOnly &&
    snap.status === "live" &&
    !streaming &&
    !asking &&
    picks.length === 0
  ) {
    buttons.push({ text: "模型", action: "models", type: "default" });
    buttons.push({ text: "思考", action: "think", type: "default" });
  }
  if (opts?.showLeave !== false && snap.status !== "left") {
    buttons.push({ text: "离开", action: "leave", type: "default" });
  }
  if (!snap.readOnly && snap.uiRequest && choices.length > 0) {
    for (const [i, choice] of choices.slice(0, 8).entries()) {
      buttons.push(
        choiceButton(i, choice.label, "ui", {
          reqId: snap.uiRequest.reqId,
          value: choice.value.length <= OPTION_VALUE ? choice.value : choice.value.slice(0, OPTION_VALUE),
        }),
      );
    }
  } else if (picks.length > 0) {
    for (const [i, option] of picks.slice(0, 8).entries()) {
      buttons.push(
        choiceButton(i, option, "pick", { value: option }),
      );
    }
  }

  return {
    title,
    template,
    markdown: truncate(lines.join("\n"), MAX_MD),
    buttons,
    streaming,
    notify: asking ? "ask" : streaming ? undefined : "done",
    overflow,
  };
}

export function formatHostList(
  hosts: Array<{
    instanceId?: string;
    pid?: number;
    sessionName?: string;
    cwd?: string;
    model?: string;
    access?: string;
    relayConnected?: boolean;
    inputRequired?: boolean;
    sharing?: boolean;
  }>,
): CardView {
  if (hosts.length === 0) {
    return {
      title: "没有本机 TUI",
      template: "grey",
      markdown:
        "本机没有正在跑的 omp TUI。\n\n打开一个 omp 终端后再 `/list`。未分享的会话可以点「开启」自动 `/collab` 并接入。",
      buttons: [],
    };
  }
  const lines = hosts.map((host, i) => {
    const name = host.sessionName || host.instanceId?.slice(0, 8) || `pid ${host.pid ?? "?"}`;
    const sharing = host.sharing === false ? " · 未分享" : " · 已分享";
    const relay = host.sharing !== false && host.relayConnected === false ? " · 中继未连" : "";
    const ask = host.inputRequired ? " · 等待输入" : "";
    const cwd = host.cwd ? `\n  \`${host.cwd}\`` : "";
    const model = host.model ? ` · ${host.model}` : "";
    return `**#${i + 1}** ${name} · pid ${host.pid ?? "?"}${model}${sharing}${relay}${ask}${cwd}`;
  });
  return {
    title: `本机 TUI ${hosts.length}`,
    template: "indigo",
    markdown: `${lines.join("\n\n")}\n\n未分享的会话会先向该 TUI 发送 \`/collab\`，成功后再接入。`,
    buttons: hosts.slice(0, 6).map((host, i) => {
      const selector = host.instanceId || (host.pid != null ? String(host.pid) : "");
      const sharing = host.sharing !== false;
      return {
        text: sharing ? `接入 #${i + 1}` : `开启 #${i + 1}`,
        action: "attach",
        type: sharing ? "primary" : "default",
        payload: { instanceId: selector, selector },
      };
    }),
  };
}

export function formatModelList(
  models: ModelPick[],
  current?: ModelPick | string,
  query?: string,
): CardView {
  const currentRef =
    typeof current === "string"
      ? current
      : current
        ? modelRef(current)
        : "";
  const shown = models.slice(0, 40);
  const lines =
    shown.length === 0
      ? ["没有匹配的模型。换个关键词，或发 `/model` 看全部。"]
      : shown.map((model, i) => {
          const ref = modelRef(model);
          const mark = ref === currentRef ? " · 当前" : "";
          const name = model.name && model.name !== model.id ? ` ${model.name}` : "";
          return `**#${i + 1}** \`${ref}\`${name}${mark}`;
        });
  if (models.length > shown.length) {
    lines.push(`\n还有 ${models.length - shown.length} 个。发 \`/model 关键词\` 缩小。`);
  }
  const q = query?.trim();
  return {
    title: q ? `模型 · ${truncate(q, 16)} ${models.length}` : `模型 ${models.length}`,
    template: "indigo",
    markdown: truncate(
      [`当前 \`${currentRef || "未知"}\``, "", ...lines].join("\n"),
      MAX_MD,
    ),
    buttons: shown.slice(0, 6).map((model, i) => ({
      text: truncate(`#${i + 1} ${model.id}`, 20),
      action: "set_model",
      type: modelRef(model) === currentRef ? "primary" : "default",
      payload: { provider: model.provider, modelId: model.id },
    })),
  };
}

export function formatThinkCard(current?: string): CardView {
  const now = (current ?? "").trim() || "未知";
  return {
    title: `思考 · ${now}`,
    template: "indigo",
    markdown: `当前 **${now}**\n\n点按钮，或发 \`/think high\`。可用：${THINK_LEVELS.join(" / ")}`,
    buttons: THINK_LEVELS.map((level) => ({
      text: level,
      action: "set_think",
      type: level === now ? "primary" : "default",
      payload: { level },
    })),
  };
}

export const HELP_TEXT = `飞书里直接用 omp（A），也可以挂本机 TUI（B）。

**A · 飞书会话**
- 直接发文字：开/续这条对话的 \`omp --mode rpc\`
- \`/new\` 新开会话
- \`/cwd <目录>\` 换工作目录
- \`/model [名称]\` 查看 / 切换模型
- \`/think [off|low|medium|high|max|auto]\` 思考强度
- \`/abort\` 打断

**B · 挂已有 TUI**
- \`/list\` 列出本机正在跑的 TUI（含未开 collab 的）
- \`/attach [序号|pid|id]\` 接入；未分享的会先开启 collab
- \`/view [序号]\` 只读
- \`/leave\` 离开 collab，回到 A

\`/status\` 当前绑定。群里要 @机器人 或打 \`/\`。`;
