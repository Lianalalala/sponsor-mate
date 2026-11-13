// AI 拆解結果的防呆。
// AI 負責把混在一格的內容拆開，但它的輸出要先通過這裡：
// 原文裡找不到的內容一律丟掉，不確定的數量不能變成確定的數字。

import { AI_CONTACT_METHODS, type ContactMethod } from "./contact.ts";

export interface RowInterpretation {
  /** AI 判斷的主要聯絡方式（不含 Email，Email 由程式判斷）；沒把握就是 null */
  contactMethod: ContactMethod | null;
  /** 主要聯絡資訊，照抄原文，例如 LINE ID、官網網址 */
  contactInfo: string | null;
  contactPerson: string | null;
  otherChannels: string | null;
  sponsorshipType: string | null;
  cashNtd: number | null;
  item: string | null;
  quantity: number | null;
  unit: string | null;
}

export interface GuardResult {
  value: RowInterpretation;
  reviewReasons: string[];
}

export const EMPTY_INTERPRETATION: RowInterpretation = {
  contactMethod: null,
  contactInfo: null,
  contactPerson: null,
  otherChannels: null,
  sponsorshipType: null,
  cashNtd: null,
  item: null,
  quantity: null,
  unit: null,
};

export const SPONSORSHIP_TYPES = [
  "現金",
  "物資",
  "現金＋物資",
  "無",
  "待確認",
  "未記載",
] as const;

function isSponsorshipType(value: string): boolean {
  return (SPONSORSHIP_TYPES as readonly string[]).includes(value);
}

// 「合約 3000」的「約」不算不確定
const UNCERTAIN_QUANTITY = /[?？]|(?<![合簽特預])約|大概|左右|待確認|待確定/;

function comparable(text: string): string {
  return text.normalize("NFKC").replace(/[\s,]/g, "");
}

function appearsIn(source: string, value: string): boolean {
  return comparable(source).includes(comparable(value));
}

export function guardInterpretation(
  input: RowInterpretation,
  contactRaw: string,
  sponsorshipRaw: string,
): GuardResult {
  const value: RowInterpretation = { ...input };
  const reviewReasons: string[] = [];

  function keepIfInSource<K extends "contactPerson" | "otherChannels">(
    field: K,
    label: string,
  ): void {
    const candidate = value[field];
    if (candidate !== null && !appearsIn(contactRaw, candidate)) {
      value[field] = null;
      reviewReasons.push(`AI 的${label}在原文找不到，已捨棄`);
    }
  }
  keepIfInSource("contactPerson", "聯絡窗口");
  keepIfInSource("otherChannels", "其他管道");

  // 主要聯絡方式：只能是 Email 以外的選項，而且一定要有原文裡找得到的聯絡資訊
  if (value.contactInfo !== null && !appearsIn(contactRaw, value.contactInfo)) {
    value.contactInfo = null;
    reviewReasons.push("AI 的主要聯絡資訊在原文找不到，已捨棄");
  }
  if (value.contactMethod !== null && !(AI_CONTACT_METHODS as readonly string[]).includes(value.contactMethod)) {
    value.contactMethod = null;
  }
  if (value.contactMethod === null || value.contactInfo === null) {
    value.contactMethod = null;
    value.contactInfo = null;
  }

  if (value.item !== null && !appearsIn(sponsorshipRaw, value.item)) {
    value.item = null;
    reviewReasons.push("AI 的贊助品項在原文找不到，已捨棄");
  }
  if (value.unit !== null && !appearsIn(sponsorshipRaw, value.unit)) {
    value.unit = null;
  }
  if (value.sponsorshipType !== null && !isSponsorshipType(value.sponsorshipType)) {
    value.sponsorshipType = null;
    reviewReasons.push("AI 的贊助類型不在選項內，已捨棄");
  }
  if (value.cashNtd !== null && !appearsIn(sponsorshipRaw, String(value.cashNtd))) {
    value.cashNtd = null;
    reviewReasons.push("AI 的現金金額在原文找不到，已捨棄");
  }
  if (value.quantity !== null && !appearsIn(sponsorshipRaw, String(value.quantity))) {
    value.quantity = null;
    reviewReasons.push("AI 的贊助數量在原文找不到，已捨棄");
  }
  // 只有原文真的寫了數字才有「不確定的數量」；單純寫「待確定」沒有數字可疑
  const sponsorshipText = sponsorshipRaw.normalize("NFKC");
  if (/\d/.test(sponsorshipText) && UNCERTAIN_QUANTITY.test(sponsorshipText)) {
    value.quantity = null;
    value.cashNtd = null;
    reviewReasons.push("原文的數量或金額不確定，需人工確認");
  }

  return { value, reviewReasons };
}
