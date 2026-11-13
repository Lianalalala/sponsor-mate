// 主要聯絡方式（D-024）：聯絡方式不只 Email。
// 有效 Email 由程式直接選 Email；沒有才用 AI 的判斷（LINE、官網表單…），AI 沒把握就留空＝待確認。
// 寄信只用 Email 欄，其他管道只給人看、人工聯絡後補登。

import type { CleanEmail } from "./email.ts";

/** ①、⑤「主要聯絡方式」下拉選單的選項；空白＝待確認 */
export const CONTACT_METHODS = ["Email", "LINE", "Messenger", "IG", "官網表單", "電話", "其他"] as const;

export type ContactMethod = (typeof CONTACT_METHODS)[number];

/** AI 只能從這幾個選；Email 一律由程式判斷 */
export const AI_CONTACT_METHODS = CONTACT_METHODS.filter((method) => method !== "Email");

export function isContactMethod(value: string): value is ContactMethod {
  return (CONTACT_METHODS as readonly string[]).includes(value);
}

export interface ContactChoice {
  method: ContactMethod | null;
  /** 主要聯絡資訊；主要聯絡方式是 Email 時不用（寄信看 Email 欄） */
  info: string;
}

/** 洗資料時決定主要聯絡方式：有效 Email 優先，沒有才看 AI 的建議 */
export function resolveContactMethod(
  email: CleanEmail,
  aiMethod: ContactMethod | null,
  aiInfo: string | null,
): ContactChoice {
  if (email.check === "valid") return { method: "Email", info: "" };
  if (aiMethod && aiMethod !== "Email" && aiInfo?.trim()) return { method: aiMethod, info: aiInfo.trim() };
  return { method: null, info: "" };
}

/** 原文只有橫線、「無」之類的，等於沒有聯絡資料 */
export function hasContactText(raw: string): boolean {
  return !/^(?:[-—–]+|無|n\/?a)?$/i.test(raw.normalize("NFKC").trim());
}

export interface ContactFacts {
  contactRaw: string;
  email: CleanEmail;
  contactMethod: ContactMethod | null;
  contactInfo: string;
}

export interface ContactCheck {
  /** 不符合寫入規則：不能確認，要補好資料 */
  block: string | null;
  /** 有聯絡資料但主要聯絡方式待確認 */
  review: string | null;
}

/**
 * 寫入規則（D-024）：
 * - 完全沒有聯絡資料 → 阻擋
 * - 主要聯絡方式＝Email → Email 不能空白且格式有效
 * - 主要聯絡方式≠Email → 主要聯絡資訊不能空白
 * - 主要聯絡方式留空 → 待確認
 */
export function checkContact(facts: ContactFacts): ContactCheck {
  const { contactMethod, contactInfo, email } = facts;
  if (contactMethod === "Email") {
    return email.value
      ? { block: null, review: null }
      : { block: `主要聯絡方式是 Email，但沒有有效 Email（${email.note}）`, review: null };
  }
  if (contactMethod !== null) {
    return contactInfo.trim()
      ? { block: null, review: null }
      : { block: `主要聯絡方式是 ${contactMethod}，主要聯絡資訊不能空白`, review: null };
  }
  const anything = hasContactText(facts.contactRaw) || email.value !== null || contactInfo.trim() !== "";
  if (!anything) return { block: "沒有任何聯絡資訊", review: null };
  return { block: null, review: "主要聯絡方式待確認" };
}
