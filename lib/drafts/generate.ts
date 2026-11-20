import type {
  DraftFailure,
  DraftFieldValues,
  DraftGenerationResult,
  DraftIssue,
  DraftTemplate,
  DraftTemplateInspection,
} from "./types.ts";

type Token = string | { readonly field: string };
type MessagePart = "subject" | "body";

const FIELD_NAME = /^[\p{L}_][\p{L}\p{N}_]*$/u;
const LINE_BREAK = /[\r\n\u0085\u2028\u2029]/u;

function parsePart(text: string, part: MessagePart): Token[] | DraftIssue {
  if (typeof text !== "string" || text.trim() === "") {
    return { code: "empty_template", part, message: "請提供非空白的公版文字。" };
  }
  if (part === "subject" && LINE_BREAK.test(text)) {
    return { code: "subject_line_break", part, message: "主旨不能包含換行。" };
  }

  const invalidPlaceholder: DraftIssue = {
    code: "invalid_placeholder",
    part,
    message: "欄位請使用 {{欄位名稱}}，名稱限中英文字、數字及底線，且不能以數字開頭。",
  };
  const tokens: Token[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf("{{", cursor);
    const strayClose = text.indexOf("}}", cursor);
    if (strayClose !== -1 && (open === -1 || strayClose < open)) {
      return invalidPlaceholder;
    }
    if (open === -1) {
      tokens.push(text.slice(cursor));
      break;
    }
    tokens.push(text.slice(cursor, open));
    const close = text.indexOf("}}", open + 2);
    if (close === -1) return invalidPlaceholder;
    const field = text.slice(open + 2, close).trim();
    if (!FIELD_NAME.test(field) || text[close + 2] === "}") {
      return invalidPlaceholder;
    }
    tokens.push({ field });
    cursor = close + 2;
  }
  return tokens;
}

function analyzeTemplate(template: DraftTemplate): DraftFailure | {
  readonly ok: true;
  readonly subject: readonly Token[];
  readonly body: readonly Token[];
  readonly requiredFields: readonly string[];
} {
  const issues: DraftIssue[] = [];
  if (template.kind !== "initial_invitation" && template.kind !== "follow_up") {
    issues.push({ code: "invalid_kind", part: "kind", message: "請選擇初次邀約或追蹤公版。" });
  }
  const subject = parsePart(template.subject, "subject");
  const body = parsePart(template.body, "body");
  if (!Array.isArray(subject)) issues.push(subject);
  if (!Array.isArray(body)) issues.push(body);
  if (!Array.isArray(subject) || !Array.isArray(body) || issues.length > 0) {
    return { ok: false, issues };
  }

  const fields = new Set<string>();
  for (const token of [...subject, ...body]) {
    if (typeof token !== "string") fields.add(token.field);
  }
  return { ok: true, subject, body, requiredFields: [...fields] };
}

/** 先檢查公版，依主旨、內文首次出現的順序列出需要提供的欄位。 */
export function inspectDraftTemplate(template: DraftTemplate): DraftTemplateInspection {
  const analysis = analyzeTemplate(template);
  if (!analysis.ok) return analysis;
  return { ok: true, requiredFields: analysis.requiredFields };
}

/** 離線、單次純文字替換；失敗時不回傳部分草稿，也不推測或補寫資料。 */
export function generateDraft(
  template: DraftTemplate,
  values: DraftFieldValues,
): DraftGenerationResult {
  const analysis = analyzeTemplate(template);
  if (!analysis.ok) return analysis;

  const resolved = new Map<string, string>();
  const issues: DraftIssue[] = [];
  for (const field of analysis.requiredFields) {
    // 不採用原型鏈上的值，也不執行 getter 或把物件強制轉成文字。
    const descriptor = values !== null && typeof values === "object"
      ? Object.getOwnPropertyDescriptor(values, field)
      : undefined;
    if (!descriptor || ("value" in descriptor &&
      (descriptor.value === undefined ||
        (typeof descriptor.value === "string" && descriptor.value.trim() === "")))) {
      issues.push({ code: "missing_field_value", part: "values", field, message: "請補齊此欄位的資料。" });
    } else if (!("value" in descriptor) || typeof descriptor.value !== "string") {
      issues.push({ code: "invalid_field_value", part: "values", field, message: "欄位資料必須是文字。" });
    } else {
      resolved.set(field, descriptor.value);
    }
  }
  if (issues.length > 0) return { ok: false, issues };

  const render = (tokens: readonly Token[]) => tokens.map((token) =>
    typeof token === "string" ? token : resolved.get(token.field)!,
  ).join("");
  const subject = render(analysis.subject);
  if (LINE_BREAK.test(subject)) {
    return {
      ok: false,
      issues: [{ code: "subject_line_break", part: "subject", message: "填入資料後的主旨不能包含換行。" }],
    };
  }

  return {
    ok: true,
    draft: {
      kind: template.kind,
      subject,
      body: render(analysis.body),
      status: "draft",
      perMessageApproval: "not_approved",
    },
    usedFields: analysis.requiredFields,
  };
}
