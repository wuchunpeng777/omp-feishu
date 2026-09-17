/** 从环境变量读取桥接配置。 */

export type FeishuDomain = "feishu" | "lark";

export type AppConfig = {
  appId: string;
  appSecret: string;
  domain: FeishuDomain;
  allowOpenIds: Set<string>;
  ompBin: string;
  displayName: string;
};

function optional(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`缺少环境变量 ${name}，请复制 .env.example 为 .env 后填写`);
  }
  return value;
}

export function loadBotConfig(): AppConfig {
  const domainRaw = optional("FEISHU_DOMAIN", "feishu").toLowerCase();
  const domain: FeishuDomain = domainRaw === "lark" ? "lark" : "feishu";
  const allow = optional("FEISHU_ALLOW_OPEN_IDS", "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return {
    appId: required("FEISHU_APP_ID"),
    appSecret: required("FEISHU_APP_SECRET"),
    domain,
    allowOpenIds: new Set(allow),
    ompBin: optional("OMP_BIN", "omp"),
    displayName: optional("OMP_DISPLAY_NAME", "飞书"),
  };
}

export function loadOmpConfig(): Pick<AppConfig, "ompBin" | "displayName"> {
  return {
    ompBin: optional("OMP_BIN", "omp"),
    displayName: optional("OMP_DISPLAY_NAME", "飞书"),
  };
}
