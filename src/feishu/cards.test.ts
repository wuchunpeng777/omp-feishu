import { expect, test } from "bun:test";
import type { CardView } from "../bridge/format.ts";
import {
  buildCardV2,
  canTypewriter,
  cardStructure,
  STREAM_MD_ID,
} from "./cards.ts";

function view(partial: Partial<CardView> = {}): CardView {
  return {
    title: "运行中 · omp",
    template: "orange",
    markdown: "**会话** omp\n\n**输出**\nhello",
    buttons: [{ text: "打断", action: "abort", type: "danger" }],
    streaming: true,
    ...partial,
  };
}

test("JSON 2.0 流式卡片带 markdown element_id 和 callback 按钮", () => {
  const card = buildCardV2(view());
  expect(card.schema).toBe("2.0");
  const config = card.config as { streaming_mode?: boolean };
  expect(config.streaming_mode).toBe(true);
  const body = card.body as { elements: Array<Record<string, unknown>> };
  const md = body.elements[0] as { tag: string; element_id: string; content: string };
  expect(md.tag).toBe("markdown");
  expect(md.element_id).toBe(STREAM_MD_ID);
  expect(md.content).toContain("hello");
  const btn = body.elements[1] as {
    tag: string;
    behaviors: Array<{ type: string; value: { action: string } }>;
  };
  expect(btn.tag).toBe("button");
  expect(btn.behaviors[0]?.type).toBe("callback");
  expect(btn.behaviors[0]?.value.action).toBe("abort");
});

test("结束后关掉 streaming_mode", () => {
  const card = buildCardV2(view({ streaming: false, template: "green", title: "已接入 · omp" }));
  const config = card.config as { streaming_mode?: boolean };
  expect(config.streaming_mode).toBe(false);
});

test("正文前缀加长才打字机，结构变了就整卡覆盖", () => {
  const first = view();
  const live = {
    streaming: true,
    structure: cardStructure(first),
    markdown: first.markdown,
  };
  expect(
    canTypewriter(live, view({ markdown: first.markdown + " world" })),
  ).toBe(true);
  expect(canTypewriter(live, view({ markdown: first.markdown }))).toBe(false);
  expect(canTypewriter(live, view({ markdown: "**会话** other" }))).toBe(false);
  expect(
    canTypewriter(live, view({ title: "已接入 · omp", streaming: false })),
  ).toBe(false);
  expect(
    canTypewriter(
      live,
      view({
        markdown: first.markdown + " world",
        buttons: [
          { text: "打断", action: "abort", type: "danger" },
          { text: "离开", action: "leave" },
        ],
      }),
    ),
  ).toBe(false);
});
