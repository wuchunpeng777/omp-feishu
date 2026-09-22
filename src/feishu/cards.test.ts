import { expect, test } from "bun:test";
import type { CardView } from "../bridge/format.ts";
import {
  buildCardV2,
  canTypewriter,
  cardStructure,
  CLOCK_ID,
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
  const ticking = view({ title: "运行中 · 1:05" });
  const later = view({ title: "运行中 · 1:06", markdown: ticking.markdown + " world" });
  expect(cardStructure(ticking)).toBe(cardStructure(later));
  expect(
    canTypewriter(
      { streaming: true, structure: cardStructure(ticking), markdown: ticking.markdown },
      later,
    ),
  ).toBe(true);
});

test("运行中的时长在标题标签和正文，结束后退回会话名", () => {
  const card = buildCardV2(view({ title: "运行中 · 1:05" }));
  const header = card.header as {
    title: { content: string };
    text_tag_list: Array<{ element_id: string; text: { content: string } }>;
  };
  expect(header.title.content).toBe("运行中");
  expect(header.text_tag_list[0]?.text.content).toBe("1:05");
  const body = card.body as { elements: Array<{ element_id?: string; content?: string }> };
  expect(body.elements[0]?.element_id).toBe(CLOCK_ID);
  expect(body.elements[0]?.content).toBe("**运行中 · 1:05**");
  const hour = buildCardV2(view({ title: "运行中 · 1:01:02" }));
  const hourHeader = hour.header as {
    text_tag_list: Array<{ text: { content: string } }>;
  };
  expect(hourHeader.text_tag_list[0]?.text.content).toBe("1:01:02");
  const idle = buildCardV2(view({ streaming: false, title: "已接入 · omp", template: "green" }));
  const idleHeader = idle.header as { title: { content: string }; text_tag_list?: unknown };
  expect(idleHeader.title.content).toBe("已接入 · omp");
  expect(idleHeader.text_tag_list).toBeUndefined();
  const idleBody = idle.body as { elements: Array<{ element_id?: string }> };
  expect(idleBody.elements[0]?.element_id).toBe(STREAM_MD_ID);
});

test("选项按钮通栏并带 hover 全文", () => {
  const card = buildCardV2(
    view({
      streaming: false,
      buttons: [
        {
          text: "1. 用 TypeScript 重写整个模块…",
          action: "ui",
          type: "primary",
          width: "fill",
          hoverTips: "1. 用 TypeScript 重写整个模块并补齐边界测试",
          payload: { reqId: "r1", value: "用 TypeScript 重写整个模块并补齐边界测试" },
        },
      ],
    }),
  );
  const body = card.body as { elements: Array<Record<string, unknown>> };
  const btn = body.elements[1] as {
    tag: string;
    width?: string;
    hover_tips?: { content: string };
  };
  expect(btn.tag).toBe("button");
  expect(btn.width).toBe("fill");
  expect(btn.hover_tips?.content).toContain("补齐边界测试");
});

test("超长输出用默认展开的折叠面板", () => {
  const card = buildCardV2(
    view({
      streaming: false,
      overflow: { title: "全文", content: "结论：选用方案乙。" },
    }),
  );
  const body = card.body as { elements: Array<Record<string, unknown>> };
  const panel = body.elements[1] as {
    tag: string;
    expanded?: boolean;
    element_id?: string;
    elements: Array<{ content: string }>;
  };
  expect(panel.tag).toBe("collapsible_panel");
  expect(panel.expanded).toBe(true);
  expect(panel.element_id).toBe("overflow_md");
  expect(panel.elements[0]?.content).toContain("方案乙");
});
