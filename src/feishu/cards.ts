/** 飞书消息卡片（schema 1.0，可 patch）。 */

import type { CardButton, CardView } from "../bridge/format.ts";

export function buildCard(view: CardView): Record<string, unknown> {
  const actions = view.buttons.map((button) => buttonElement(button));
  const elements: unknown[] = [
    {
      tag: "div",
      text: { tag: "lark_md", content: view.markdown },
    },
  ];
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

function buttonElement(button: CardButton): Record<string, unknown> {
  const value: Record<string, string> = { action: button.action };
  if (button.payload) {
    for (const [k, v] of Object.entries(button.payload)) value[k] = v;
  }
  return {
    tag: "button",
    text: { tag: "plain_text", content: button.text },
    type: button.type ?? "default",
    value,
  };
}

export function cardContent(view: CardView): string {
  return JSON.stringify(buildCard(view));
}
