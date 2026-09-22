/** 飞书卡片：JSON 2.0（CardKit 流式）+ 1.0 回退。 */

import type { CardButton, CardView } from "../bridge/format.ts";

export const STREAM_MD_ID = "md_body";
export const CLOCK_ID = "md_clock";
export const ELAPSED_ID = "elapsed";

const ELAPSED = / · (\d+:\d{2}(?::\d{2})?)$/;

/** `运行中 · 1:05` / `运行中 · 1:01:02` → 时长；其它标题没有。 */
export function elapsedOf(title: string): string {
  return ELAPSED.exec(title)?.[1] ?? "";
}

/** 时长每秒变，不能算进结构，否则打字机会被整卡覆盖打断。 */
function stableTitle(title: string): string {
  return title.replace(ELAPSED, "");
}

export function cardStructure(view: CardView): string {
  const buttons = view.buttons
    .map((button) => `${button.action}:${button.text}`)
    .join(",");
  const overflow = view.overflow ? `\n${view.overflow.title}:${view.overflow.content.length}` : "";
  return `${stableTitle(view.title)}\n${view.template}\n${buttons}${overflow}`;
}

/** 结构没变、正文是前缀加长、且仍在流式 → 走打字机，否则整卡覆盖。 */
export function canTypewriter(
  live: { streaming: boolean; structure: string; markdown: string },
  view: CardView,
): boolean {
  if (!live.streaming || view.streaming !== true) return false;
  if (cardStructure(view) !== live.structure) return false;
  const next = view.markdown;
  return next.length > live.markdown.length && next.startsWith(live.markdown);
}

export function buildCard(view: CardView): Record<string, unknown> {
  const actions = view.buttons.map((button) => buttonElementV1(button));
  const elements: unknown[] = [
    {
      tag: "div",
      text: { tag: "lark_md", content: view.markdown },
    },
  ];
  if (view.overflow?.content) {
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: `**${view.overflow.title}**\n${view.overflow.content}`,
      },
    });
  }
  if (actions.length > 0) {
    elements.push({ tag: "action", actions });
  }
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: "plain_text", content: view.title },
      template: view.template,
    },
    elements,
  };
}

export function buildCardV2(view: CardView): Record<string, unknown> {
  const streaming = view.streaming === true;
  const clock = streaming ? elapsedOf(view.title) : "";
  const elements: unknown[] = [];
  if (clock) {
    elements.push({
      tag: "markdown",
      content: `**${view.title}**`,
      element_id: CLOCK_ID,
    });
  }
  elements.push({
    tag: "markdown",
    content: view.markdown || "…",
    element_id: STREAM_MD_ID,
  });
  if (view.overflow?.content) {
    elements.push(overflowPanel(view.overflow));
  }
  view.buttons.forEach((button, i) => {
    elements.push(buttonElementV2(button, i));
  });
  const header: Record<string, unknown> = {
    title: {
      tag: "plain_text",
      content: clock ? stableTitle(view.title) : view.title,
    },
    template: view.template,
  };
  if (clock) {
    header.text_tag_list = [
      {
        tag: "text_tag",
        element_id: ELAPSED_ID,
        text: { tag: "plain_text", content: clock },
        color: "orange",
      },
    ];
  }
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      streaming_mode: streaming,
      summary: { content: view.title },
      streaming_config: {
        print_frequency_ms: { default: 70 },
        print_step: { default: 2 },
        print_strategy: "fast",
      },
    },
    header,
    body: { elements },
  };
}

function buttonValue(button: CardButton): Record<string, string> {
  const value: Record<string, string> = { action: button.action };
  if (button.payload) {
    for (const [k, v] of Object.entries(button.payload)) value[k] = v;
  }
  return value;
}

function buttonElementV1(button: CardButton): Record<string, unknown> {
  const text =
    button.text.length <= 20 ? button.text : `${button.text.slice(0, 19)}…`;
  return {
    tag: "button",
    text: { tag: "plain_text", content: text },
    type: button.type ?? "default",
    value: buttonValue(button),
  };
}

function buttonElementV2(
  button: CardButton,
  index: number,
): Record<string, unknown> {
  const value = buttonValue(button);
  const el: Record<string, unknown> = {
    tag: "button",
    element_id: `btn_${index}`,
    text: { tag: "plain_text", content: button.text },
    type: button.type ?? "default",
    behaviors: [{ type: "callback", value }],
  };
  if (button.width === "fill") el.width = "fill";
  if (button.hoverTips) {
    el.hover_tips = { tag: "plain_text", content: button.hoverTips };
  }
  return el;
}

function overflowPanel(overflow: { title: string; content: string }): Record<string, unknown> {
  return {
    tag: "collapsible_panel",
    element_id: "overflow_md",
    expanded: true,
    header: {
      title: { tag: "markdown", content: `**${overflow.title}**` },
      vertical_align: "center",
      icon: {
        tag: "standard_icon",
        token: "down-small-ccm_outlined",
        size: "16px 16px",
      },
      icon_position: "right",
      icon_expanded_angle: -180,
    },
    border: { color: "grey", corner_radius: "5px" },
    padding: "8px",
    elements: [{ tag: "markdown", content: overflow.content }],
  };
}

export function cardContent(view: CardView): string {
  return JSON.stringify(buildCard(view));
}

export function cardContentV2(view: CardView): string {
  return JSON.stringify(buildCardV2(view));
}
