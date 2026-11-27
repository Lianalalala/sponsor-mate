import { parseInstant } from "../rules/time.ts";
import type {
  ApprovedMailReview,
  MailReview,
  PendingMailReview,
  ReviewActor,
  ReviewDraft,
  ReviewErrorCode,
  ReviewFailure,
  ReviewResult,
} from "./types.ts";

const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nullableText = (value: unknown) => value === null || text(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && Array.from(value).every((item) => text(item) && !/[\r\n]/.test(item));

const ERROR_MESSAGES: Record<ReviewErrorCode, string> = {
  invalid_draft: "草稿資料不完整或格式錯誤，請重新載入後再送審。",
  invalid_review: "審核紀錄不完整或格式錯誤，請核對紀錄來源。",
  forbidden: "目前身分沒有此社團的操作權限。",
  invalid_time: "操作時間須有效且包含時區，核准時間不能早於送審時間。",
  different_draft: "審核紀錄不屬於目前這封草稿或社團。",
  invalid_state: "只有待審核的紀錄可以核准，失效後須重新送審。",
  draft_changed: "草稿內容或版本已變更，請重新送審。",
};

function failure(code: ReviewErrorCode): ReviewFailure {
  return { ok: false, code, message: ERROR_MESSAGES[code] };
}

// 只驗證快照結構；Email、資料基準、附件需求與連結存取仍由寄前檢核處理。
function validDraft(value: unknown): value is ReviewDraft {
  if (!record(value) || !text(value.id) || !text(value.clubId) || !text(value.revision) ||
    !text(value.subject) || /[\r\n\u0085\u2028\u2029]/u.test(value.subject) || !text(value.body) ||
    !strings(value.to) || value.to.length === 0 || !strings(value.cc) || !strings(value.bcc) ||
    !nullableText(value.contactId) || !record(value.vendor) || !record(value.event)) return false;
  if (!nullableText(value.vendor.id) || !nullableText(value.vendor.name) ||
    !nullableText(value.event.id) || !nullableText(value.event.name) || !nullableText(value.event.date) ||
    !record(value.event.fields) || !Object.values(value.event.fields).every(nullableText)) return false;
  return Array.isArray(value.attachments) && Array.from(value.attachments).every((file) =>
    record(file) && nullableText(file.fileRef) && nullableText(file.version),
  ) && Array.isArray(value.links) && Array.from(value.links).every((link) =>
    record(link) && text(link.url) && nullableText(link.resourceVersion),
  );
}

function validReview(value: unknown): value is MailReview {
  if (!record(value) || !validDraft(value.snapshot) || !record(value.submission) ||
    !text(value.submission.submittedBy) || typeof value.submission.submittedAt !== "string") return false;
  const submittedAt = parseInstant(value.submission.submittedAt);
  if (submittedAt === null) return false;
  const snapshot = value.snapshot;
  const approval = value.approval;
  const validApproval = () => {
    if (!record(approval) || !text(approval.reviewerId) || typeof approval.approvedAt !== "string" ||
      approval.draftRevision !== snapshot.revision) return false;
    const approvedAt = parseInstant(approval.approvedAt);
    return approvedAt !== null && approvedAt >= submittedAt;
  };
  if (value.status === "pending_review") return approval === null;
  if (value.status === "approved") return validApproval();
  return value.status === "invalidated" && value.invalidationReason === "draft_changed" &&
    (approval === null || validApproval());
}

function authorized(actor: ReviewActor, clubId: string, permission: "canSubmitForReview" | "canApprove") {
  return record(actor) && text(actor.id) && actor.clubId === clubId && actor[permission] === true;
}

/** 拷貝並凍結已知欄位，避免呼叫端修改輸入時連帶改掉送審／核准快照。 */
function copyDraft(draft: ReviewDraft): ReviewDraft {
  return Object.freeze({
    id: draft.id, clubId: draft.clubId, revision: draft.revision,
    to: Object.freeze([...draft.to]), cc: Object.freeze([...draft.cc]), bcc: Object.freeze([...draft.bcc]),
    subject: draft.subject, body: draft.body, contactId: draft.contactId,
    vendor: Object.freeze({ id: draft.vendor.id, name: draft.vendor.name }),
    event: Object.freeze({ id: draft.event.id, name: draft.event.name, date: draft.event.date,
      fields: Object.freeze(Object.fromEntries(Object.entries(draft.event.fields).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ))),
    }),
    attachments: Object.freeze(draft.attachments.map((file) => Object.freeze({ fileRef: file.fileRef, version: file.version }))),
    links: Object.freeze(draft.links.map((link) => Object.freeze({ url: link.url, resourceVersion: link.resourceVersion }))),
  });
}

function copyReview(review: MailReview): MailReview {
  const base = {
    snapshot: copyDraft(review.snapshot),
    submission: Object.freeze({ submittedBy: review.submission.submittedBy, submittedAt: review.submission.submittedAt }),
  };
  const approval = review.approval === null ? null : Object.freeze({
    reviewerId: review.approval.reviewerId, approvedAt: review.approval.approvedAt,
    draftRevision: review.approval.draftRevision,
  });
  if (review.status === "pending_review") return Object.freeze({ ...base, status: "pending_review", approval: null });
  if (review.status === "approved") {
    return Object.freeze({ ...base, status: "approved", approval: approval! });
  }
  return Object.freeze({ ...base, status: "invalidated", approval, invalidationReason: "draft_changed" });
}

function sameIdentity(review: MailReview, draft: ReviewDraft) {
  return review.snapshot.id === draft.id && review.snapshot.clubId === draft.clubId;
}

function sameDraft(review: MailReview, draft: ReviewDraft) {
  // copyDraft 使用固定欄位順序，活動欄位按 key 排序；其餘陣列、文字與版本逐一精確比較。
  return JSON.stringify(copyDraft(review.snapshot)) === JSON.stringify(copyDraft(draft));
}

/** 建立單封待審核紀錄；時間與已驗證的操作者皆由後端提供。 */
export function submitForReview(
  draft: ReviewDraft,
  actor: ReviewActor,
  submittedAt: string,
): ReviewResult<PendingMailReview> {
  if (!validDraft(draft)) return failure("invalid_draft");
  if (!authorized(actor, draft.clubId, "canSubmitForReview")) return failure("forbidden");
  if (parseInstant(submittedAt) === null) return failure("invalid_time");
  return {
    ok: true,
    review: Object.freeze({ status: "pending_review", snapshot: copyDraft(draft),
      submission: Object.freeze({ submittedBy: actor.id, submittedAt }), approval: null }),
  };
}

/**
 * 用目前草稿核對原紀錄。任何版本／內容變更都失效；已失效的紀錄不因改回舊文字而復活。
 * 呼叫端須在修改與讀取審核狀態時執行，並透過 DAL 保存失效狀態與舊紀錄。
 */
export function reconcileReview(review: MailReview, currentDraft: ReviewDraft): ReviewResult {
  if (!validReview(review)) return failure("invalid_review");
  if (!validDraft(currentDraft)) return failure("invalid_draft");
  if (!sameIdentity(review, currentDraft)) return failure("different_draft");
  if (review.status === "invalidated" || sameDraft(review, currentDraft)) {
    return { ok: true, review: copyReview(review) };
  }
  return { ok: true, review: copyReview({ ...review, status: "invalidated", invalidationReason: "draft_changed" }) };
}

/** 只核准仍與送審快照完全一致的單封草稿；結果不是寄信許可或認證憑證。 */
export function approveReview(
  review: MailReview,
  currentDraft: ReviewDraft,
  actor: ReviewActor,
  approvedAt: string,
): ReviewResult<ApprovedMailReview> {
  if (!validReview(review)) return failure("invalid_review");
  if (!validDraft(currentDraft)) return failure("invalid_draft");
  if (!sameIdentity(review, currentDraft)) return failure("different_draft");
  if (!authorized(actor, currentDraft.clubId, "canApprove")) return failure("forbidden");
  if (review.status !== "pending_review") return failure("invalid_state");
  if (!sameDraft(review, currentDraft)) return failure("draft_changed");
  const time = parseInstant(approvedAt);
  if (time === null || time < parseInstant(review.submission.submittedAt)!) return failure("invalid_time");
  return {
    ok: true,
    review: Object.freeze({ status: "approved", snapshot: copyDraft(review.snapshot),
      submission: Object.freeze({ submittedBy: review.submission.submittedBy, submittedAt: review.submission.submittedAt }),
      approval: Object.freeze({ reviewerId: actor.id, approvedAt, draftRevision: review.snapshot.revision }) }),
  };
}
