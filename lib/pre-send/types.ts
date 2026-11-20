export type CheckStatus = "pass" | "needs_review" | "block";
export type CheckCategory = "context" | "recipient" | "vendor" | "event" | "attachments" | "links";

export interface Finding {
  readonly category: CheckCategory;
  readonly status: CheckStatus;
  readonly code: string;
  readonly message: string;
  readonly requiredAction: string;
}

export interface CategoryResult {
  readonly category: CheckCategory;
  readonly status: CheckStatus;
  readonly findings: readonly Finding[];
}

/** 由可信的資料存取層提供；status 不是可直接信任的前端核准旗標。 */
export interface Confirmed<T> {
  readonly status: "confirmed" | "unknown";
  readonly value: T | null;
}

export interface VendorData {
  readonly id: string | null;
  readonly name: string | null;
}

export interface EventData {
  readonly id: string | null;
  readonly name: string | null;
  /** 已確認的活動日期，限 YYYY-MM-DD；不從文字或本機時區推測。 */
  readonly date: string | null;
  readonly fields: Readonly<Record<string, string | null>>;
}

export interface ContactData {
  readonly id: string | null;
  readonly vendorId: string | null;
  readonly email: string | null;
  readonly validity: "current" | "replaced" | "unknown";
}

export interface AttachmentData {
  readonly fileRef: string | null;
  /** null 表示實際版本未知；基準中則表示未指定版本要求。 */
  readonly version: string | null;
}

export interface DraftLink {
  readonly url: string;
  /** 非版本化資源可明確填 null。 */
  readonly resourceVersion: string | null;
}

export interface StructuredDraft {
  readonly id: string;
  readonly revision: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly contactId: string | null;
  readonly vendor: VendorData;
  readonly event: EventData;
  readonly attachments: readonly AttachmentData[];
  readonly links: readonly DraftLink[];
}

export interface ReferenceData {
  readonly revision: string;
  readonly vendor: Confirmed<VendorData>;
  readonly contact: Confirmed<ContactData>;
  readonly event: Confirmed<EventData>;
}

export interface PreSendPolicy {
  /** [] 表示只有固定的活動 ID、名稱、日期必填；null 表示規則未決。 */
  readonly requiredEventFields: readonly string[] | null;
  readonly attachments: {
    readonly requirement: "required" | "optional" | "unknown";
    /** 指定檔案參照；只有 version 非 null 時才檢查該檔案版本。 */
    readonly expected: Confirmed<readonly AttachmentData[]>;
  };
  readonly linksRequired: boolean | null;
}

export interface LinkEvidence {
  readonly url: string;
  readonly resourceVersion: string | null;
  readonly draftId: string;
  readonly draftRevision: string;
  readonly referenceRevision: string;
  readonly recipientEmail: string;
  readonly attachmentSnapshot: readonly AttachmentData[];
  readonly reviewerId: string;
  readonly checkedAt: string;
  readonly availability: "reachable" | "broken" | "unknown";
  readonly access: "allowed" | "denied" | "unknown";
}

export interface EvidenceBundle {
  /** 純函式無法認證來源；只能由後端驗證、載入後設定，不能信任前端自報。 */
  readonly source: "trusted_server" | "untrusted";
  readonly links: readonly LinkEvidence[];
}

export interface PreSendInput {
  readonly draft: StructuredDraft;
  readonly references: ReferenceData | null;
  readonly policy: PreSendPolicy;
  readonly evidence: EvidenceBundle | null;
}

export interface PreSendResult {
  readonly status: CheckStatus;
  readonly checks: readonly CategoryResult[];
  readonly findings: readonly Finding[];
  readonly counts: Readonly<Record<CheckStatus, number>>;
  readonly draftId: string;
  readonly draftRevision: string;
  readonly referenceRevision: string | null;
  readonly validationScope: "structured_data_only";
  readonly finalMessageValidation: "not_checked";
  readonly perMessageApproval: "not_checked";
}
