// 只檢查參數中的結構化資料，不讀環境變數、不連網、不執行寄送。
import { parseInstant } from "../rules/time.ts";
import type {
  AttachmentData, CategoryResult, CheckCategory, CheckStatus, Confirmed, Finding,
  LinkEvidence, PreSendInput, PreSendResult,
} from "./types.ts";

const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const version = (value: unknown): value is string | null => value === null || text(value);
const confirmed = <T>(value: Confirmed<T> | null | undefined): T | null =>
  value?.status === "confirmed" ? value.value ?? null : null;

function finding(category: CheckCategory, status: CheckStatus, code: string, message: string, requiredAction: string): Finding {
  return { category, status, code, message, requiredAction };
}

function statusOf(findings: readonly Finding[]): CheckStatus {
  return findings.some((item) => item.status === "block") ? "block" :
    findings.some((item) => item.status === "needs_review") ? "needs_review" : "pass";
}

function result(category: CheckCategory, findings: Finding[], passMessage: string): CategoryResult {
  const items = findings.length > 0 ? findings :
    [finding(category, "pass", `${category}.matched`, passMessage, "無需處理此檢核項目。")];
  return { category, status: statusOf(items), findings: items };
}

// MVP 僅接受單純 ASCII Email，不從顯示名稱、文字或多地址字串擷取收件人。
// 只將網域轉小寫，不改 local-part、不刪除 +tag 或 Gmail 的點。
function email(value: unknown): string | null {
  if (!text(value) || /[\r\n]/.test(value)) return null;
  const address = value.trim();
  const parts = address.split("@");
  if (parts.length !== 2 || address.length > 254) return null;
  const [local, domain] = parts;
  if (local.length > 64 || !/^[A-Za-z0-9_%+-]+(?:\.[A-Za-z0-9_%+-]+)*$/.test(local)) return null;
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((label) =>
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) return null;
  return `${local}@${domain.toLowerCase()}`;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    parseInstant(`${value}T00:00:00Z`) !== null;
}

export function checkRecipient(input: PreSendInput): CategoryResult {
  const { draft } = input;
  const items: Finding[] = [];
  const add = (status: CheckStatus, code: string, message: string, action: string) =>
    items.push(finding("recipient", status, code, message, action));
  if (!Array.isArray(draft.to) || draft.to.length === 0) {
    add("block", "recipient.missing", "缺少 To 收件人。", "填入一位已確認的聯絡窗口。");
  } else if (draft.to.length !== 1 || draft.to.some((value) => typeof value === "string" && /[,;]/.test(value))) {
    add("block", "recipient.unsupported_multiple", "首版不支援多位 To 收件人。", "改為單一 To，再重新檢核。");
  }
  for (const key of ["cc", "bcc"] as const) {
    if (!Array.isArray(draft[key])) add("needs_review", "recipient.routing_unknown", "無法確認 Cc／Bcc 是否為空。", "提供完整收件人結構。");
    else if (draft[key].length > 0) add("block", "recipient.unsupported_copy", "首版不支援 Cc 或 Bcc。", "移除 Cc／Bcc，改以支援的單一 To 流程處理。");
  }
  const actual = Array.isArray(draft.to) && draft.to.length === 1 ? email(draft.to[0]) : null;
  if (Array.isArray(draft.to) && draft.to.length === 1 && actual === null) {
    add("block", "recipient.invalid_email", "收件人不是首版支援的單一 Email 格式。", "核對地址，不要從混合文字自動擷取或猜測地址。");
  }
  const base = confirmed(input.references?.contact);
  if (!base || !text(base.id) || !text(base.vendorId) || email(base.email) === null) {
    add("needs_review", "recipient.reference_unknown", "聯絡窗口基準未確認或資料不完整。", "先確認窗口識別、廠商關聯與有效 Email。");
  } else {
    if (base.validity === "replaced") add("block", "recipient.replaced", "此窗口已失效或被替換。", "選擇目前有效的窗口。");
    else if (base.validity !== "current") add("needs_review", "recipient.validity_unknown", "窗口是否仍有效尚未確認。", "由幹部確認窗口有效性。");
    if (!text(draft.contactId)) add("needs_review", "recipient.contact_unknown", "缺少寄件資料的窗口識別。", "指定預期聯絡窗口。");
    else if (draft.contactId !== base.id) add("block", "recipient.contact_mismatch", "所選窗口與已確認窗口不符。", "重新選擇正確窗口。");
    if (!text(draft.vendor?.id)) add("needs_review", "recipient.vendor_unknown", "無法核對窗口所屬廠商。", "補齊寄件資料的廠商識別。");
    else if (draft.vendor.id !== base.vendorId) add("block", "recipient.vendor_mismatch", "收件窗口不屬於此廠商。", "核對廠商與窗口關聯。");
    if (actual !== null && actual !== email(base.email)) add("block", "recipient.email_mismatch", "收件地址與已確認窗口不一致。", "核對並修正收件地址或更新經確認的窗口資料。");
  }
  return result("recipient", items, "單一 To 與已確認且有效的廠商窗口一致。");
}

export function checkVendor(input: PreSendInput): CategoryResult {
  const items: Finding[] = [];
  const add = (status: CheckStatus, code: string, message: string, action: string) =>
    items.push(finding("vendor", status, code, message, action));
  const actual = input.draft.vendor, base = confirmed(input.references?.vendor);
  if (!text(actual?.id) || !text(actual?.name)) add("block", "vendor.missing", "廠商 ID 或完整名稱缺漏。", "補齊已確認的廠商資料。");
  if (!base || !text(base.id) || !text(base.name)) {
    add("needs_review", "vendor.reference_unknown", "廠商基準未確認或無效。", "先確認正式廠商 ID 與名稱。");
  } else {
    if (text(actual?.id) && actual.id !== base.id) add("block", "vendor.id_mismatch", "廠商 ID 不符。", "改用正確廠商資料。");
    if (text(actual?.name) && actual.name.trim() !== base.name.trim()) add("block", "vendor.name_mismatch", "廠商名稱不符合已確認名稱；不自動接受別名。", "使用已確認名稱，別名須先經核准。");
  }
  return result("vendor", items, "廠商 ID 與完整名稱符合已確認資料。");
}

export function checkEvent(input: PreSendInput): CategoryResult {
  const items: Finding[] = [];
  const add = (status: CheckStatus, code: string, message: string, action: string) =>
    items.push(finding("event", status, code, message, action));
  const actual = input.draft.event, base = confirmed(input.references?.event);
  if (!text(actual?.id) || !text(actual?.name) || !validDate(actual?.date)) {
    add("block", "event.missing_or_invalid", "活動 ID、名稱或有效日期缺漏。", "補齊活動資料，日期使用 YYYY-MM-DD。");
  }
  const validBase = base !== null && text(base.id) && text(base.name) && validDate(base.date) && record(base.fields);
  if (!validBase) add("needs_review", "event.reference_unknown", "活動基準未確認或無效。", "先確認活動 ID、名稱、日期與欄位資料。");
  else {
    if (text(actual?.id) && actual.id !== base.id) add("block", "event.id_mismatch", "活動 ID 與已確認活動不符。", "核對活動選擇。");
    if (text(actual?.name) && actual.name.trim() !== base.name!.trim()) add("block", "event.name_mismatch", "活動名稱與已確認資料不符。", "使用已確認活動名稱。");
    if (validDate(actual?.date) && actual.date !== base.date) add("block", "event.date_mismatch", "活動日期與已確認資料不符。", "使用已確認活動日期。");
  }
  const required = input.policy.requiredEventFields;
  const validRequired = Array.isArray(required) && Array.from(required).every(text);
  if (!validRequired) add("needs_review", "event.requirements_unknown", "其他活動必填欄位尚未決定或設定無效。", "提供必填欄位清單，無其他必填時明確提供空陣列。");
  if (!record(actual?.fields)) add("needs_review", "event.fields_unknown", "活動額外欄位結構缺漏。", "提供結構化活動欄位，無額外欄位時提供空物件。");
  else {
    const keys = new Set([...(validRequired ? required : []), ...Object.keys(actual.fields)]);
    for (const key of keys) {
      const supplied = Object.hasOwn(actual.fields, key);
      const value = supplied ? actual.fields[key] : null;
      const isRequired = validRequired && required.includes(key);
      if (!text(value)) {
        if (isRequired) add("block", "event.required_field_missing", "設定指定的活動必填欄位缺漏。", `補齊欄位：${key}`);
        else if (value !== null && value !== undefined && typeof value !== "string") add("block", "event.field_invalid", "活動欄位不是有效文字。", `核對欄位：${key}`);
        else if (supplied) add("needs_review", "event.field_unknown", "已列入寄件資料的活動欄位內容未知。", `確認欄位：${key}；若不使用此選填欄位，請明確移除。`);
      } else if (validBase) {
        const expected = Object.hasOwn(base.fields, key) ? base.fields[key] : null;
        if (!text(expected)) add("needs_review", "event.field_reference_unknown", "提供的活動欄位缺少已確認基準。", `先確認欄位：${key}`);
        else if (value.trim() !== expected.trim()) add("block", "event.field_mismatch", "活動欄位與已確認資料不符。", `修正欄位：${key}`);
      }
    }
  }
  return result("event", items, "活動 ID、名稱、日期及設定指定欄位均符合已確認資料。");
}

function validAttachments(value: unknown): value is readonly AttachmentData[] {
  return Array.isArray(value) && Array.from(value).every((item) => record(item) && text(item.fileRef) && version(item.version));
}

export function checkAttachments(input: PreSendInput): CategoryResult {
  const items: Finding[] = [];
  const add = (status: CheckStatus, code: string, message: string, action: string) =>
    items.push(finding("attachments", status, code, message, action));
  const actual = input.draft.attachments, policy = input.policy.attachments;
  if (!Array.isArray(actual)) {
    add("needs_review", "attachments.list_unknown", "無法確認實際附件清單。", "提供完整附件清單，沒有附件時明確提供空陣列。");
    return result("attachments", items, "");
  }
  if (!["required", "optional"].includes(policy?.requirement)) add("needs_review", "attachments.requirement_unknown", "附件需求尚未確認。", "確認本封信的附件是必填或選用。");
  if (actual.length === 0) {
    if (policy?.requirement === "required") add("block", "attachments.required_missing", "本封信明確要求附件，但沒有附件。", "附上指定附件後重新檢核。");
    return result("attachments", items, "附件為選用，本封信沒有附件，符合需求。");
  }
  if (!validAttachments(actual)) add("needs_review", "attachments.metadata_unknown", "附件識別或版本資料無法確認。", "補齊檔案參照；未指定版本時可明確填 null。");
  const expected = confirmed(policy?.expected);
  if (!validAttachments(expected) || new Set(expected.map((item) => item.fileRef)).size !== expected.length ||
    (policy?.requirement === "required" && expected.length === 0)) {
    add("needs_review", "attachments.reference_unknown", "指定附件的基準未確認、不完整或有歧義。", "確認指定檔案參照與是否有版本要求。");
    return result("attachments", items, "");
  }
  for (const file of actual) {
    if (!file || !text(file.fileRef)) continue;
    const target = expected.find((candidate) => candidate.fileRef === file.fileRef);
    if (!target) add("needs_review", "attachments.unexpected", "包含未列於已確認基準的額外附件。", "確認額外附件用途，勿直接假設可寄送。");
    else if (target.version !== null) {
      if (!text(file.version)) add("needs_review", "attachments.version_unknown", "已有指定版本，但實際附件版本未知。", "核對實際檔案版本。");
      else if (file.version !== target.version) add("block", "attachments.version_mismatch", "附件版本與指定版本不符。", "替換成指定版本。");
    }
  }
  if (policy?.requirement === "required") {
    for (const target of expected) {
      if (!actual.some((file) => file?.fileRef === target.fileRef)) add("block", "attachments.file_missing", "缺少明確指定的附件。", "補上指定檔案，不能只以相同檔名替代。");
    }
  }
  return result("attachments", items, "實際附件符合指定檔案及有明確指定的版本要求。");
}

function httpUrl(value: unknown): URL | null {
  if (!text(value) || /\s/.test(value) || !/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    return url.hostname !== "" && ["http:", "https:"].includes(url.protocol) ? url : null;
  } catch { return null; }
}

function attachmentSignature(files: readonly AttachmentData[]): string | null {
  if (!validAttachments(files)) return null;
  // 排序副本，保留重複檔案與版本差異，不改變輸入順序。
  return JSON.stringify(files.map((file) => JSON.stringify([file.fileRef, file.version])).sort());
}

function evidenceMatches(evidence: LinkEvidence, input: PreSendInput, link: PreSendInput["draft"]["links"][number]): boolean {
  const { draft, references } = input;
  const signature = attachmentSignature(draft.attachments);
  return signature !== null && signature === attachmentSignature(evidence.attachmentSnapshot) &&
    text(draft.id) && text(draft.revision) && text(references?.revision) &&
    evidence.draftId === draft.id && evidence.draftRevision === draft.revision &&
    evidence.referenceRevision === references?.revision &&
    Array.isArray(draft.to) && draft.to.length === 1 && email(draft.to[0]) !== null &&
    email(evidence.recipientEmail) === email(draft.to[0]) &&
    version(link.resourceVersion) && evidence.resourceVersion === link.resourceVersion &&
    httpUrl(evidence.url)?.href === httpUrl(link.url)?.href && text(evidence.reviewerId) &&
    parseInstant(evidence.checkedAt) !== null;
}

export function checkLinks(input: PreSendInput): CategoryResult {
  const items: Finding[] = [];
  const add = (status: CheckStatus, code: string, message: string, action: string) =>
    items.push(finding("links", status, code, message, action));
  const links = input.draft.links;
  if (typeof input.policy.linksRequired !== "boolean") add("needs_review", "links.requirement_unknown", "是否必須附上連結尚未確認。", "確認連結需求。");
  if (!Array.isArray(links)) {
    add("needs_review", "links.list_unknown", "無法確認完整連結清單。", "提供完整清單，沒有連結時明確提供空陣列。");
    return result("links", items, "");
  }
  if (links.length === 0) {
    if (input.policy.linksRequired === true) add("block", "links.required_missing", "缺少明確要求的連結。", "補上指定連結。");
    return result("links", items, "本封信不要求連結，清單為空。");
  }
  for (const link of links) {
    const url = httpUrl(link?.url);
    if (url === null) {
      add("block", "links.invalid_url", "連結格式無效或使用不支援的協定。", "改用格式完整的 HTTP／HTTPS URL。");
      continue;
    }
    if (url.protocol === "http:") add("needs_review", "links.http_review", "HTTP 連結需人工確認，未驗證安全性。", "由幹部核對 HTTP 連結的用途與風險。");
    const bundle = input.evidence;
    const candidates = bundle?.source === "trusted_server" && Array.isArray(bundle.links) ?
      bundle.links.filter((evidence) => evidence && evidenceMatches(evidence, input, link)) : [];
    if (candidates.length === 0) {
      add("needs_review", "links.evidence_missing_or_stale", "缺少可信且適用目前收件人、附件及版本的連結確認證據。", "重新核對連結有效性及收件人權限，由後端載入確認人、時間與版本紀錄。");
      continue;
    }
    if (candidates.some((evidence) => evidence.availability === "broken")) add("block", "links.known_broken", "適用的確認證據顯示連結失效。", "修復或替換連結後重新確認。");
    else if (candidates.some((evidence) => evidence.availability !== "reachable")) add("needs_review", "links.availability_unknown", "尚未確認連結是否有效。", "由幹部確認可開啟連結。");
    if (candidates.some((evidence) => evidence.access === "denied")) add("block", "links.known_denied", "適用的確認證據顯示收件人無權限。", "修正分享權限或替換資源後重新確認。");
    else if (candidates.some((evidence) => evidence.access !== "allowed")) add("needs_review", "links.access_unknown", "尚未確認收件人能否存取。", "以實際收件人身分或適用方式核對權限。");
  }
  return result("links", items, "URL 格式與輸入的有效性／權限確認證據一致；本函式未連網驗證。");
}

export function checkPreSend(input: PreSendInput): PreSendResult {
  const checks = [checkRecipient(input), checkVendor(input), checkEvent(input), checkAttachments(input), checkLinks(input)];
  const findings = checks.flatMap((check) => check.findings);
  if (![input.draft.id, input.draft.revision, input.references?.revision].every(text)) {
    findings.push(finding("context", "needs_review", "context.version_unknown", "缺少信件或基準資料版本，無法綁定檢核結果。", "補齊信件 ID、信件版本及基準資料版本。"));
  }
  const counts = { pass: 0, needs_review: 0, block: 0 };
  for (const item of findings) counts[item.status]++;
  return { status: statusOf(findings), checks, findings, counts,
    draftId: input.draft.id, draftRevision: input.draft.revision, referenceRevision: input.references?.revision ?? null,
    validationScope: "structured_data_only", finalMessageValidation: "not_checked", perMessageApproval: "not_checked" };
}
