// Email 清洗：從可能混了窗口、LINE、電話的文字裡找出 email。
// 原則：絕不補 @、不修正拼字；找不到或有多個，就留空交給人判斷。

export type EmailCheck =
  | "valid"
  | "missing"
  | "invalid_no_at" // 例如 lifestyle.example.com
  | "invalid_format" // 有 @ 但格式不對
  | "multiple"; // 同一格有多個不同的 email

export interface CleanEmail {
  value: string | null;
  check: EmailCheck;
  candidates: string[];
  note: string;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const LOOKS_LIKE_DOMAIN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const BROKEN_EMAIL = /[A-Za-z0-9._%+-]@|@[A-Za-z0-9-]+\.[A-Za-z]/;

export function cleanEmail(raw: string): CleanEmail {
  const text = raw.normalize("NFKC").trim();
  const found = text.match(EMAIL) ?? [];
  const candidates = [...new Set(found.map((email) => email.toLowerCase()))];

  if (candidates.length === 1) {
    return { value: candidates[0], check: "valid", candidates, note: "格式有效" };
  }
  if (candidates.length > 1) {
    return {
      value: null,
      check: "multiple",
      candidates,
      note: `同一格有多個 Email，需人工選擇：${candidates.join("、")}`,
    };
  }
  if (LOOKS_LIKE_DOMAIN.test(text)) {
    return { value: null, check: "invalid_no_at", candidates, note: `格式無效（缺@）：${raw}` };
  }
  if (BROKEN_EMAIL.test(text)) {
    return { value: null, check: "invalid_format", candidates, note: `格式無效：${raw}` };
  }
  return { value: null, check: "missing", candidates, note: "沒有 Email" };
}
