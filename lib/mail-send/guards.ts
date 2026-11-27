// 供可信伺服器接線與離線測試使用的純函式；沒有寄送、讀取資料或認證功能。
import { reconcileReview, type MailReview, type ReviewDraft } from "../mail-review/index.ts";
import type { Confirmed } from "../pre-send/types.ts";

/** 後端驗證 Session、成員及寄送權限後提供；不能採用 request body 自報的能力。 */
export interface SendGuardActor {
  readonly id: string;
  readonly clubId: string;
  readonly canSend: boolean;
}

/** 從同社團①廠商主檔取得的目前資料，不以⑤暫存或③停止追蹤代替。 */
export interface SendGuardVendor {
  readonly clubId: string;
  readonly vendorId: string;
  readonly revision: string;
  readonly stopContact: Confirmed<boolean>;
}

export interface SendGuardInput {
  readonly actor: SendGuardActor | null;
  readonly draft: ReviewDraft;
  /** 必須由可信後端載入，不接受前端自行組裝的已核准物件。 */
  readonly review: MailReview | null;
  readonly vendor: SendGuardVendor | null;
}

export type SendGuardFinding =
  | { readonly code: "access"; readonly reason: "not_signed_in" | "forbidden" | "scope_mismatch" }
  | { readonly code: "data"; readonly reason: "input_invalid" | "draft_identity_invalid" | "vendor_unconfirmed" | "vendor_mismatch" }
  | { readonly code: "E01"; readonly reason: "review_missing" | "review_invalid" | "review_mismatch" |
      "draft_invalid" | "not_approved" | "approval_invalidated" }
  | { readonly code: "E02"; readonly reason: "stop_contact" };

export interface SendGuardBinding {
  readonly clubId: string;
  readonly draftId: string;
  readonly draftRevision: string;
  readonly vendorId: string;
  readonly vendorRevision: string;
}

export type SendGuardResult =
  | { readonly status: "blocked"; readonly scope: "E01_E02_only"; readonly findings: readonly SendGuardFinding[] }
  | { readonly status: "guards_passed"; readonly scope: "E01_E02_only"; readonly binding: SendGuardBinding };

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

function blocked(...findings: SendGuardFinding[]): SendGuardResult {
  return Object.freeze({
    status: "blocked", scope: "E01_E02_only",
    findings: Object.freeze(findings.map((item) => Object.freeze({ ...item }))),
  });
}

/**
 * 只回答目前輸入是否符合 E01／E02，不產生最終寄送許可。
 * 來源真實性、最新版本及檢查後的競爭控制，須由正式伺服器／DAL 保證。
 * 不修改或回傳完整草稿／審核紀錄，也不記錄原始例外或信件內容。
 */
export function evaluateSendGuards(input: SendGuardInput): SendGuardResult {
  if (!record(input)) return blocked({ code: "data", reason: "input_invalid" });
  const actor = input.actor;
  if (actor === null) return blocked({ code: "access", reason: "not_signed_in" });
  if (!record(actor) || !text(actor.id) || !text(actor.clubId) || actor.canSend !== true) {
    return blocked({ code: "access", reason: "forbidden" });
  }
  const draft = input.draft;
  if (!record(draft) || !text(draft.id) || !text(draft.revision) || !text(draft.clubId) ||
    !record(draft.vendor) || !text(draft.vendor.id)) {
    return blocked({ code: "data", reason: "draft_identity_invalid" });
  }
  if (actor.clubId !== draft.clubId) return blocked({ code: "access", reason: "scope_mismatch" });

  const vendor = input.vendor;
  // 不處理或回傳其他社團／廠商的資料；讀不到本社團資料則在下面回未確認。
  if (record(vendor) && text(vendor.clubId) && vendor.clubId !== actor.clubId) {
    return blocked({ code: "access", reason: "scope_mismatch" });
  }
  if (record(vendor) && text(vendor.vendorId) && vendor.vendorId !== draft.vendor.id) {
    return blocked({ code: "data", reason: "vendor_mismatch" });
  }

  const findings: SendGuardFinding[] = [];
  if (input.review === null || input.review === undefined) {
    findings.push({ code: "E01", reason: "review_missing" });
  } else {
    try {
      const reconciled = reconcileReview(input.review, draft);
      if (!reconciled.ok) {
        findings.push({ code: "E01", reason: reconciled.code === "different_draft" ? "review_mismatch" :
          reconciled.code === "invalid_draft" ? "draft_invalid" : "review_invalid" });
      } else if (reconciled.review.status === "invalidated") {
        findings.push({ code: "E01", reason: "approval_invalidated" });
      } else if (reconciled.review.status !== "approved") {
        findings.push({ code: "E01", reason: "not_approved" });
      }
    } catch {
      // 可信資料結構仍出現非預期錯誤時不放行，也不回傳例外。
      findings.push({ code: "E01", reason: "review_invalid" });
    }
  }

  const validVendor = record(vendor) && vendor.clubId === actor.clubId &&
    vendor.vendorId === draft.vendor.id && text(vendor.revision) &&
    record(vendor.stopContact) && vendor.stopContact.status === "confirmed" &&
    typeof vendor.stopContact.value === "boolean";
  if (!validVendor) return blocked(...findings, { code: "data", reason: "vendor_unconfirmed" });
  if (vendor.stopContact.value === true) findings.push({ code: "E02", reason: "stop_contact" });

  if (findings.length > 0) return blocked(...findings);
  return Object.freeze({
    status: "guards_passed", scope: "E01_E02_only",
    binding: Object.freeze({
      clubId: actor.clubId, draftId: draft.id, draftRevision: draft.revision,
      vendorId: draft.vendor.id, vendorRevision: vendor.revision,
    }),
  });
}
