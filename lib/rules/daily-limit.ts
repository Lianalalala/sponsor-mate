import { inspectClubMails } from "./history.ts";
import { parseInstant, toTaipeiDate } from "./time.ts";
import type { MailRecord, RuleIssue, RuleReason } from "./types.ts";

// 既有產品規則，不是 Google API 的服務上限。
export const DAILY_SEND_LIMIT = 30;

export function evaluateDailyQuota(input: {
  readonly clubId: string;
  readonly mails: readonly MailRecord[];
  readonly now: string;
}) {
  const inspected = inspectClubMails(input.mails, input.clubId);
  const issues: RuleIssue[] = [...inspected.issues];
  const now = parseInstant(input.now);
  const date = toTaipeiDate(input.now);
  if (now === null) issues.push({ code: "invalid_time", message: "目前時間無效，無法確認今日寄件數。" });
  let sentToday = 0;
  for (const mail of inspected.successes) {
    const sentAt = parseInstant(mail.sentAt);
    if (sentAt === null || now === null) continue;
    if (sentAt > now) issues.push({ code: "future_time", recordId: mail.id, message: "成功寄件時間在未來，須先核對。" });
    else if (toTaipeiDate(mail.sentAt!) === date) sentToday++;
  }
  const requiresReconciliation = issues.length > 0 || inspected.unresolvedCount > 0;
  const reasons: RuleReason[] = [];
  if (sentToday >= DAILY_SEND_LIMIT) reasons.push({ code: "daily_limit", message: "已達本社團台灣時間每日 30 封成功寄件上限。" });
  if (inspected.unresolvedCount > 0) reasons.push({ code: "unresolved_send", message: "本社團有未決外寄紀錄，先暫停新增寄送；跨日仍須核對，不能直接重寄。" });
  if (issues.length > 0) reasons.push({ code: "data_review", message: "寄件資料不完整或矛盾，額度需先人工核對。" });
  return { date, limit: DAILY_SEND_LIMIT, sentToday,
    remaining: Math.max(0, DAILY_SEND_LIMIT - sentToday),
    unresolvedCount: inspected.unresolvedCount, requiresReconciliation,
    shouldPause: sentToday >= DAILY_SEND_LIMIT || requiresReconciliation, reasons, issues };
}
