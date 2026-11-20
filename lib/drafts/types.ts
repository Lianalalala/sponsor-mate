export type DraftKind = "initial_invitation" | "follow_up";

/** 使用者自行提供的純文字公版；不包含寄送或核准設定。 */
export interface DraftTemplate {
  readonly kind: DraftKind;
  readonly subject: string;
  readonly body: string;
}

/** 只填入公版實際引用的欄位；資料來源與確認狀態須由呼叫端核對。 */
export type DraftFieldValues = Readonly<Record<string, string | undefined>>;

export interface DraftIssue {
  readonly code:
    | "invalid_kind"
    | "empty_template"
    | "invalid_placeholder"
    | "missing_field_value"
    | "invalid_field_value"
    | "subject_line_break";
  readonly part: "kind" | "subject" | "body" | "values";
  readonly field?: string;
  readonly message: string;
}

export interface DraftFailure {
  readonly ok: false;
  readonly issues: readonly DraftIssue[];
}

/** 僅為生成的文字，不能當作寄前檢核或人工核准結果。 */
export interface GeneratedDraft {
  readonly kind: DraftKind;
  readonly subject: string;
  readonly body: string;
  readonly status: "draft";
  readonly perMessageApproval: "not_approved";
}

export type DraftTemplateInspection =
  | { readonly ok: true; readonly requiredFields: readonly string[] }
  | DraftFailure;

export type DraftGenerationResult =
  | {
      readonly ok: true;
      readonly draft: GeneratedDraft;
      readonly usedFields: readonly string[];
    }
  | DraftFailure;
