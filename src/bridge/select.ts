/** 飞书侧模型模糊匹配、思考强度解析。 */

export type ModelPick = {
  provider: string;
  id: string;
  name?: string;
};

export const THINK_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "auto",
] as const;

export type ThinkLevel = (typeof THINK_LEVELS)[number];

const THINK_ALIAS: Record<string, ThinkLevel> = {
  off: "off",
  none: "off",
  关: "off",
  关闭: "off",
  minimal: "minimal",
  min: "minimal",
  low: "low",
  lo: "low",
  低: "low",
  medium: "medium",
  med: "medium",
  mid: "medium",
  中: "medium",
  high: "high",
  hi: "high",
  高: "high",
  xhigh: "xhigh",
  xhi: "xhigh",
  max: "max",
  最大: "max",
  auto: "auto",
  自动: "auto",
};

export function modelRef(model: ModelPick): string {
  return `${model.provider}/${model.id}`;
}

function scoreModel(model: ModelPick, query: string): number {
  const id = model.id.toLowerCase();
  const provider = model.provider.toLowerCase();
  const ref = `${provider}/${id}`;
  const name = (model.name ?? "").toLowerCase();
  if (ref === query) return 100;
  if (id === query) return 90;
  if (ref.endsWith(`/${query}`)) return 88;
  if (id.startsWith(query) || ref.startsWith(query)) return 70;
  if (id.includes(query) || ref.includes(query)) return 50;
  if (name.includes(query)) return 35;
  if (provider.includes(query)) return 20;
  const parts = query.split(/[\s/]+/).filter(Boolean);
  if (parts.length > 1 && parts.every((part) => ref.includes(part) || name.includes(part))) {
    return 40;
  }
  return 0;
}

/** 无关键词返回全部。唯一高置信命中只回一条，其余按分数列出。 */
export function matchModels(models: ModelPick[], query: string): ModelPick[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  const scored = models
    .map((model) => ({ model, score: scoreModel(model, q) }))
    .filter((row) => row.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.model.provider.localeCompare(b.model.provider) ||
        a.model.id.localeCompare(b.model.id),
    );
  if (scored.length === 0) return [];
  const best = scored[0].score;
  const top = scored.filter((row) => row.score === best);
  if (top.length === 1 && best >= 70) return [top[0].model];
  return scored.map((row) => row.model);
}

export function parseThinkLevel(raw: string): ThinkLevel | undefined {
  const q = raw.trim().toLowerCase();
  if (!q) return undefined;
  const aliased = THINK_ALIAS[q];
  if (aliased) return aliased;
  if (q.length < 2) return undefined;
  const matches = THINK_LEVELS.filter((level) => level.startsWith(q));
  return matches.length === 1 ? matches[0] : undefined;
}
