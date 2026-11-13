// 純資料契約；不是 Sheets 欄位解析器，也不執行登入或社團授權。
export interface Scope {
  readonly clubId: string;
  readonly vendorId: string;
  readonly eventId: string;
}

export interface Correspondence extends Scope {
  readonly id: string;
  // 暫沿用既有清洗模組的用字；正式下拉選項仍須團隊確認。
  readonly contactStatus: string | null;
  // 內部語意，非新增 Sheets 下拉選項；未知／待確認不能當成 continue。
  readonly processingDecision: "continue" | "stop" | "needs_review";
}

export interface MailRecord {
  readonly id: string;
  readonly clubId: string;
  readonly correspondenceId: string;
  readonly eventId: string;
  readonly direction: "寄出" | "收到（人工補登）";
  readonly kind: "首次邀約" | "催信" | "其他外寄" | "回覆補登";
  readonly status: "未寄送" | "寄送中" | "成功" | "失敗" | "待確認" | "不適用（補登回覆）";
  readonly sentAt: string | null;
  readonly gmailMessageId: string | null;
}

export interface HistoryInput {
  readonly scope: Scope;
  readonly correspondences: readonly Correspondence[];
  readonly mails: readonly MailRecord[];
}

export interface RuleIssue {
  readonly code: "invalid_scope" | "invalid_record" | "invalid_time" | "future_time" |
    "missing_evidence" | "conflicting_record" | "invalid_relation";
  readonly message: string;
  readonly recordId?: string;
}

export interface SendHistory {
  readonly successCount: number;
  readonly followUpCount: number;
  readonly unresolvedCount: number;
  readonly lastSuccessfulSentAt: string | null;
  readonly issues: readonly RuleIssue[];
}

export interface FollowUpSettings {
  readonly intervalDays: number;
  /** 僅計成功的「催信」，不含首次邀約。沒有正式預設值。 */
  readonly maxFollowUps: number;
}

export interface FollowUpInput extends HistoryInput {
  readonly now: string;
  readonly settings: FollowUpSettings;
  /** 廠商層級，跨活動都須遵守。 */
  readonly vendorStopContact: boolean;
  /** 由幹部處理結果提供；收到回覆不等於已處理。 */
  readonly hasUnhandledReply: boolean;
}

export interface RuleReason {
  readonly code: "data_review" | "unresolved_send" | "invalid_settings" | "stop_contact" |
    "rejected" | "stop_follow_up" | "decision_review" | "pending_reply" | "contact_review" |
    "not_awaiting_reply" | "no_successful_send" | "follow_up_limit" | "interval_not_met" |
    "follow_up_suggested" | "daily_limit";
  readonly message: string;
}
