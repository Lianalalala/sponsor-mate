// 模型設定集中在這裡（D-003 模型抽象層）。只能在伺服器端 import。
// API key 放在 .env.local 的 ANTHROPIC_API_KEY，由 @ai-sdk/anthropic 自動讀取。

import { anthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";

const DEFAULT_MODEL = "claude-haiku-5-5";

export function getWashingModel(): LanguageModel {
  return anthropic(process.env.WASHING_MODEL ?? DEFAULT_MODEL);
}
