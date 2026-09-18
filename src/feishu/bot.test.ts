import { expect, test } from "bun:test";
import { MessageDeduper } from "./bot.ts";

test("同一飞书消息只允许首次处理", () => {
  let now = 1000;
  const deduper = new MessageDeduper(() => now, 100);

  expect(deduper.claim("om_1")).toBe(true);
  expect(deduper.claim("om_1")).toBe(false);
  expect(deduper.claim("om_2")).toBe(true);

  now += 101;
  expect(deduper.claim("om_1")).toBe(true);
});

test("空消息 ID 不阻塞后续处理", () => {
  const deduper = new MessageDeduper();
  expect(deduper.claim("")).toBe(true);
  expect(deduper.claim("")).toBe(true);
});
