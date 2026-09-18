import { expect, test } from "bun:test";
import { matchModels, parseThinkLevel } from "./select.ts";

const models = [
  { provider: "xai", id: "grok-4.6", name: "Grok 4.6" },
  { provider: "xai", id: "grok-4", name: "Grok 4" },
  { provider: "anthropic", id: "claude-opus-4", name: "Opus 4" },
  { provider: "anthropic", id: "claude-sonnet-4", name: "Sonnet 4" },
  { provider: "openai", id: "gpt-5.2", name: "GPT-5.2" },
];

test("精确 provider/id 只命中一条", () => {
  const hits = matchModels(models, "xai/grok-4");
  expect(hits).toEqual([models[1]]);
});

test("唯一前缀命中直接选中", () => {
  const hits = matchModels(models, "gpt-5");
  expect(hits).toEqual([models[4]]);
});

test("模糊关键词列出多个", () => {
  const hits = matchModels(models, "claude");
  expect(hits.map((m) => m.id)).toEqual(["claude-opus-4", "claude-sonnet-4"]);
});

test("没有匹配返回空", () => {
  expect(matchModels(models, "minimax")).toEqual([]);
});

test("思考强度缩写和中文", () => {
  expect(parseThinkLevel("hi")).toBe("high");
  expect(parseThinkLevel("med")).toBe("medium");
  expect(parseThinkLevel("自动")).toBe("auto");
  expect(parseThinkLevel("关")).toBe("off");
  expect(parseThinkLevel("nope")).toBeUndefined();
  expect(parseThinkLevel("m")).toBeUndefined();
});
