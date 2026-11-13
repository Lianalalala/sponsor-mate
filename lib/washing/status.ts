// 狀態與停止聯絡的判斷。這些規則可以明確計算，所以由程式處理，不交給 AI。
// 原則：對應表沒有的說法一律「待釐清」，不過度推論。

// 與資料表③「聯絡狀態」下拉選單的選項一致
export type ContactStatus =
  | "未聯絡"
  | "已寄出・尚未回覆"
  | "已回覆・待處理"
  | "洽談中"
  | "已同意合作"
  | "已拒絕";

export type DecisionCandidate = "待確認" | "停止追蹤" | "停止追蹤（限該活動）";

export interface StatusResult {
  /** 符合③下拉選項的狀態；無法判斷時為 null */
  status: ContactStatus | null;
  /** 顯示用，例如「待釐清（原文：沒回）」 */
  label: string;
  /** 能否不經人工核對直接採用 */
  adoptable: boolean;
  decision: DecisionCandidate;
  reason: string | null;
}

interface StatusRule {
  status: ContactStatus;
  adoptable: boolean;
  decision?: DecisionCandidate;
  reason?: string;
}

const SENT_NOT_REPLIED: StatusRule = {
  status: "已寄出・尚未回覆",
  adoptable: false,
  reason: "舊表只寫已寄，須驗證寄信證據",
};
const REPLIED: StatusRule = { status: "已回覆・待處理", adoptable: true };
const NOT_CONTACTED: StatusRule = { status: "未聯絡", adoptable: true };
const AGREED: StatusRule = {
  status: "已同意合作",
  adoptable: false,
  reason: "缺合作佐證，須確認正式合作文件",
};
const REFUSED: StatusRule = {
  status: "已拒絕",
  adoptable: true,
  decision: "停止追蹤（限該活動）",
};

const STATUS_RULES: Record<string, StatusRule> = {
  "已寄,待回": SENT_NOT_REPLIED,
  "已寄,未回": SENT_NOT_REPLIED,
  "已寄,尚未回覆": SENT_NOT_REPLIED,
  已回信: REPLIED,
  已回覆: REPLIED,
  待寄: NOT_CONTACTED,
  未寄: NOT_CONTACTED,
  未聯絡: NOT_CONTACTED,
  已合作: AGREED,
  確定合作: AGREED,
  同意贊助: AGREED,
  拒絕: REFUSED,
  已拒絕: REFUSED,
  婉拒: REFUSED,
  // ③的狀態名稱本身；從⑤讀回待處理的列時，狀態候選就是這些字
  "已寄出・尚未回覆": SENT_NOT_REPLIED,
  "已回覆・待處理": REPLIED,
  已同意合作: AGREED,
};

const UNCLEAR = /^待釐清（原文：([^]*)）$/;

/** ⑤的「聯絡狀態候選」→ 可以再交給 interpretStatus 的原文 */
export function statusRawFromLabel(label: string): string {
  const unclear = UNCLEAR.exec(label);
  if (!unclear) return label;
  return unclear[1] === "空白" ? "" : unclear[1];
}

function normalizeStatusKey(raw: string): string {
  return raw.normalize("NFKC").replace(/\s+/g, "");
}

export function interpretStatus(raw: string): StatusResult {
  const trimmed = raw.trim();
  const rule = STATUS_RULES[normalizeStatusKey(raw)];
  if (rule) {
    return {
      status: rule.status,
      label: rule.status,
      adoptable: rule.adoptable,
      decision: rule.decision ?? "待確認",
      reason: rule.reason ?? null,
    };
  }
  return {
    status: null,
    label: `待釐清（原文：${trimmed === "" ? "空白" : trimmed}）`,
    adoptable: false,
    decision: "待確認",
    reason: "舊表的狀態說法無法直接對應",
  };
}

const STOP_CONTACT =
  /(不要|請勿|勿|別|不用|不必)再?(聯絡|聯繫|連絡|寄信|寄)|停止(聯絡|聯繫|連絡|寄信)/;

/**
 * 偵測「廠商要求停止聯絡」。這是保護條件，寧可多抓再由人排除，
 * 所以 AI 或後續步驟只能新增此標記，不能移除。
 */
export function detectStopContact(...texts: string[]): boolean {
  return texts.some((text) => STOP_CONTACT.test(text.normalize("NFKC").replace(/\s+/g, "")));
}

export type ContactValidity = "not_provided" | "unverified" | "replaced";

const CONTACT_REPLACED = /舊窗口|換窗口|窗口已換|前窗口/;

/** 舊窗口一律不能當成可用的聯絡資料 */
export function assessContactValidity(
  person: string | null,
  ...texts: string[]
): ContactValidity {
  if (texts.some((text) => CONTACT_REPLACED.test(text))) return "replaced";
  return person ? "unverified" : "not_provided";
}
