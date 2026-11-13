import { calendarDaysBetween, parseInstant } from "./time.ts";
import type { Correspondence, HistoryInput, MailRecord, RuleIssue, SendHistory } from "./types.ts";

const nonblank = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

// 只比較規則真正使用的欄位。相同證據重複出現不重算；矛盾證據交人工核對。
function signature(mail: MailRecord): string {
  return JSON.stringify([mail.clubId, mail.correspondenceId, mail.eventId, mail.direction,
    mail.kind, mail.status, mail.sentAt, mail.gmailMessageId]);
}

function deduplicate(mails: readonly MailRecord[], issues: RuleIssue[]): MailRecord[] {
  let result = [...mails];
  for (const key of ["id", "gmailMessageId"] as const) {
    const groups = new Map<string, MailRecord[]>();
    for (const mail of result) {
      const value = mail[key];
      if (!nonblank(value)) continue;
      const group = groups.get(value) ?? [];
      group.push(mail);
      groups.set(value, group);
    }
    const rejected = new Set<MailRecord>();
    const duplicates = new Set<MailRecord>();
    for (const group of groups.values()) {
      if (group.some((mail) => signature(mail) !== signature(group[0]))) {
        issues.push({ code: "conflicting_record", recordId: group[0].id, message: "相同信件識別碼有矛盾紀錄，須核對寄送結果。" });
        group.forEach((mail) => rejected.add(mail));
      } else {
        group.slice(1).forEach((mail) => duplicates.add(mail));
      }
    }
    result = result.filter((mail) => !rejected.has(mail) && !duplicates.has(mail));
  }
  return result;
}

/** 內部共用：只處理指定社團；每日額度不需依賴③是否完整。 */
export function inspectClubMails(mails: readonly MailRecord[], clubId: string) {
  const issues: RuleIssue[] = [];
  if (!nonblank(clubId)) issues.push({ code: "invalid_scope", message: "缺少社團識別，無法確認統計範圍。" });
  const successes: MailRecord[] = [];
  let unresolvedCount = 0;
  const scoped = mails.filter((mail) => mail.clubId === clubId);
  for (const mail of deduplicate(scoped, issues)) {
    if (mail.direction === "收到（人工補登）") continue;
    if (mail.direction !== "寄出" || !nonblank(mail.id) || !nonblank(mail.eventId) ||
      !nonblank(mail.correspondenceId) || !["首次邀約", "催信", "其他外寄"].includes(mail.kind)) {
      issues.push({ code: "invalid_record", recordId: mail.id, message: "外寄紀錄的識別、方向或類型不完整。" });
      continue;
    }
    if (mail.status === "寄送中" || mail.status === "待確認") {
      unresolvedCount++;
    } else if (mail.status === "成功") {
      if (!nonblank(mail.gmailMessageId)) {
        issues.push({ code: "missing_evidence", recordId: mail.id, message: "成功紀錄缺少 Gmail Message ID，須核對成功證據。" });
        continue;
      }
      successes.push(mail);
      if (parseInstant(mail.sentAt) === null) {
        issues.push({ code: "invalid_time", recordId: mail.id, message: "成功寄件缺少有效且含時區的寄送時間。" });
      }
    } else if (!["未寄送", "失敗"].includes(mail.status) || nonblank(mail.gmailMessageId)) {
      issues.push({ code: "invalid_record", recordId: mail.id, message: "寄送狀態不明，或寄送狀態與成功證據不一致。" });
    }
  }
  return { successes, unresolvedCount, issues };
}

/** 依③往來 ID 找出同社團、廠商、活動；不信任④單獨填寫的活動 ID。 */
export function inspectScope(input: HistoryInput) {
  const { scope, correspondences, mails } = input;
  const issues: RuleIssue[] = [];
  if (![scope.clubId, scope.vendorId, scope.eventId].every(nonblank)) {
    issues.push({ code: "invalid_scope", message: "社團、廠商與活動識別皆須提供。" });
  }
  const targets = correspondences.filter((row) => row.clubId === scope.clubId &&
    row.vendorId === scope.vendorId && row.eventId === scope.eventId);
  const correspondence: Correspondence | null = targets.length === 1 ? targets[0] : null;
  if (targets.length !== 1 || !nonblank(correspondence?.id)) {
    issues.push({ code: "invalid_relation", message: "找不到唯一且完整的廠商與活動往來紀錄。" });
  }
  const selected: MailRecord[] = [];
  for (const mail of mails) {
    if (mail.clubId !== scope.clubId) continue;
    const linked = correspondences.filter((row) => row.clubId === scope.clubId && row.id === mail.correspondenceId);
    const belongs = linked.some((row) => row.vendorId === scope.vendorId && row.eventId === scope.eventId);
    if (!belongs && (linked.length > 0 || mail.eventId !== scope.eventId)) continue;
    if (linked.length !== 1 || !belongs || mail.eventId !== scope.eventId) {
      issues.push({ code: "invalid_relation", recordId: mail.id, message: "信件與往來紀錄的活動／廠商關聯不一致，須核對。" });
      continue;
    }
    selected.push(mail);
  }
  // 先在社團全體檢查重複成功證據，避免相同 Message ID 被分配到不同活動後各算一次。
  const club = inspectClubMails(mails, scope.clubId);
  const selectedIds = new Set(selected.map((mail) => mail.id));
  const local = inspectClubMails(selected, scope.clubId);
  const relevantConflicts = club.issues.filter((issue) => issue.code === "conflicting_record");
  const successes = club.successes.filter((mail) => selectedIds.has(mail.id));
  const result = { successes, unresolvedCount: local.unresolvedCount,
    issues: [...issues, ...local.issues.filter((issue) => issue.code !== "conflicting_record"), ...relevantConflicts], correspondence };
  return result;
}

function summarize(inspection: ReturnType<typeof inspectScope>): SendHistory {
  const { successes, unresolvedCount } = inspection;
  const times = successes.map((mail) => parseInstant(mail.sentAt));
  const hasInvalidTime = times.some((time) => time === null);
  const last = !hasInvalidTime && successes.length > 0 ? successes.reduce((a, b) =>
    parseInstant(a.sentAt)! >= parseInstant(b.sentAt)! ? a : b).sentAt : null;
  return { successCount: successes.length,
    followUpCount: successes.filter((mail) => mail.kind === "催信").length,
    unresolvedCount, lastSuccessfulSentAt: last, issues: inspection.issues };
}

export function countSuccessfulSends(input: HistoryInput): SendHistory {
  return summarize(inspectScope(input));
}

export function daysSinceLastSuccessfulSend(input: HistoryInput & { readonly now: string }) {
  const inspection = inspectScope(input);
  const history = summarize(inspection);
  const issues = [...history.issues];
  const now = parseInstant(input.now);
  if (now === null) issues.push({ code: "invalid_time", message: "目前時間必須是有效且含時區的時間。" });
  const future = now !== null && inspection.successes.some((mail) => {
    const time = parseInstant(mail.sentAt);
    return time !== null && time > now;
  });
  if (future) issues.push({ code: "future_time", message: "成功寄件時間晚於目前時間，須先核對。" });
  const daysSince = now !== null && !future && history.lastSuccessfulSentAt !== null ?
    calendarDaysBetween(history.lastSuccessfulSentAt, input.now) : null;
  return { ...history, daysSince, issues };
}
