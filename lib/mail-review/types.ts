import type { StructuredDraft } from "../pre-send/types.ts";

/** 由後端組裝的完整送審內容；revision 必須在每次修改時換成新版本。 */
export interface ReviewDraft extends StructuredDraft {
  readonly clubId: string;
  readonly subject: string;
  readonly body: string;
}

/**
 * 由伺服器驗證 session、社團與操作權限後提供。
 * 此型別不是認證機制，不可直接採用前端自報的身分或權限。
 */
export interface ReviewActor {
  readonly id: string;
  readonly clubId: string;
  readonly canSubmitForReview: boolean;
  readonly canApprove: boolean;
}

export interface ReviewSubmission {
  readonly submittedBy: string;
  readonly submittedAt: string;
}

export interface ReviewApproval {
  readonly reviewerId: string;
  readonly approvedAt: string;
  readonly draftRevision: string;
}

interface ReviewBase {
  /** 保存原送審版本，不隨目前草稿改寫；含完整信件，不得寫入錯誤紀錄。 */
  readonly snapshot: ReviewDraft;
  readonly submission: ReviewSubmission;
}

export interface PendingMailReview extends ReviewBase {
  readonly status: "pending_review";
  readonly approval: null;
}

export interface ApprovedMailReview extends ReviewBase {
  readonly status: "approved";
  readonly approval: ReviewApproval;
}

export interface InvalidatedMailReview extends ReviewBase {
  readonly status: "invalidated";
  readonly invalidationReason: "draft_changed";
  /** 保留舊核准供追溯；status 已失效，不能當成目前版本的核准。 */
  readonly approval: ReviewApproval | null;
}

export type MailReview = PendingMailReview | ApprovedMailReview | InvalidatedMailReview;

export type ReviewErrorCode =
  | "invalid_draft"
  | "invalid_review"
  | "forbidden"
  | "invalid_time"
  | "different_draft"
  | "invalid_state"
  | "draft_changed";

export interface ReviewFailure {
  readonly ok: false;
  readonly code: ReviewErrorCode;
  readonly message: string;
}

export type ReviewResult<T extends MailReview = MailReview> =
  | { readonly ok: true; readonly review: T }
  | ReviewFailure;
