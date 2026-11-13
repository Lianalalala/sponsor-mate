// 預覽頁（/import）的確認規則。全部是可計算的規則，由程式處理，不交給 AI。
// 這裡不連任何外部服務，瀏覽器和伺服器都可以用。
//
// 之後做「寫入⑤」時，伺服器端要用同一份 recheckRow／canConfirm 再檢查一次，
// 不能只相信瀏覽器送來的確認結果。

import { isContactMethod, type ContactMethod } from "./contact.ts";
import { cleanDate } from "./date.ts";
import { MERGE_DECISIONS, type MergeDecision } from "./duplicates.ts";
import { cleanEmail } from "./email.ts";
import {
  cleanVendorName,
  deriveStatus,
  finalizeRow,
  IMPORT_DISPOSITIONS,
  type ImportDisposition,
  type WashedRow,
} from "./pipeline.ts";
import { toStagingRow, type StagingCell, type StagingContext } from "./staging.ts";

/** 每列三種動作：接受／編輯後確認／不匯入。沒有動作表示還沒處理。 */
export type ReviewAction = "accepted" | "edited" | "skipped";
export type ReviewActions = Partial<Record<number, ReviewAction>>;

export const ACTION_LABEL: Record<ReviewAction, string> = {
  accepted: "已接受",
  edited: "已編輯並確認",
  skipped: "不匯入",
};

/** 「阻擋正式匯入」的列要補好資料、重新檢查通過才可以確認 */
export function canConfirm(row: WashedRow): boolean {
  return row.disposition !== "阻擋正式匯入";
}

// 整批接受只包含不需要人判斷的列；待人工覆核要一筆一筆看，阻擋的列一律不行
const BULK_ACCEPTABLE: ReadonlySet<ImportDisposition> = new Set(["可暫存", "可暫存／禁止聯絡"]);

export function bulkAcceptTargets(rows: WashedRow[], actions: ReviewActions): number[] {
  return rows
    .filter((row) => actions[row.rowNumber] === undefined && BULK_ACCEPTABLE.has(row.disposition))
    .map((row) => row.rowNumber);
}

/** 套用動作；不符合規則時回傳原本的 actions（不會讓阻擋的列被確認） */
export function applyAction(
  rows: WashedRow[],
  actions: ReviewActions,
  rowNumber: number,
  action: ReviewAction | undefined,
): ReviewActions {
  const row = rows.find((candidate) => candidate.rowNumber === rowNumber);
  if (!row) return actions;
  if (action !== undefined && action !== "skipped" && !canConfirm(row)) return actions;
  return { ...actions, [rowNumber]: action };
}

export interface RowEdit {
  vendorName: string;
  /** 空字串＝待確認 */
  contactMethod: ContactMethod | "";
  /** 主要聯絡方式是 Email 時不使用 */
  contactInfo: string;
  email: string;
  contactNote: string;
  contactDate: string;
}

export function editDefaults(row: WashedRow): RowEdit {
  return {
    vendorName: row.vendorName ?? "",
    contactMethod: row.contactMethod ?? "",
    contactInfo: row.contactInfo,
    email: row.email.value ?? "",
    contactNote: row.contactNote,
    contactDate: row.date.iso ?? "",
  };
}

/**
 * 編輯後重新檢查：用和清洗時同一套規則重算這一列。
 * 疑似重複群組維持原本的分組，停止聯絡標記只能保留、不能被編輯拿掉。
 * 同組其他列的建議可能跟著改變，所以呼叫端要再對整份資料跑一次 refreshDuplicates。
 */
export function recheckRow(row: WashedRow, edit: RowEdit): WashedRow {
  const vendorName = cleanVendorName(edit.vendorName);
  const contactMethod = isContactMethod(edit.contactMethod) ? edit.contactMethod : null;
  const facts = {
    ...row,
    vendorName,
    contactMethod,
    // 選 Email 時不使用主要聯絡資訊（D-024），畫面上也不顯示這一欄
    contactInfo: contactMethod === "Email" ? "" : edit.contactInfo.trim(),
    contactNote: edit.contactNote.trim(),
    email: cleanEmail(edit.email),
    date: cleanDate(edit.contactDate),
    status: deriveStatus(row.statusRaw, vendorName, row.vendorStopContact),
  };
  return finalizeRow(facts);
}

export type DispositionCounts = Record<ImportDisposition, number>;

export function countByDisposition(rows: WashedRow[]): DispositionCounts {
  const counts = Object.fromEntries(IMPORT_DISPOSITIONS.map((label) => [label, 0])) as DispositionCounts;
  for (const row of rows) counts[row.disposition] += 1;
  return counts;
}

export interface ReviewSection {
  /** 疑似重複群組代號；null 表示單筆 */
  duplicateGroup: string | null;
  rows: WashedRow[];
}

/** 疑似重複的列排在一起（放在群組第一筆原本的位置），其他照原始順序 */
export function orderForReview(rows: WashedRow[]): ReviewSection[] {
  const sections: ReviewSection[] = [];
  const groupSections = new Map<string, ReviewSection>();
  for (const row of rows) {
    if (!row.duplicateGroup) {
      sections.push({ duplicateGroup: null, rows: [row] });
      continue;
    }
    const existing = groupSections.get(row.duplicateGroup);
    if (existing) {
      existing.rows.push(row);
    } else {
      const section = { duplicateGroup: row.duplicateGroup, rows: [row] };
      groupSections.set(row.duplicateGroup, section);
      sections.push(section);
    }
  }
  return sections;
}

export type ReviewField =
  | "廠商名稱"
  | "主要聯絡方式"
  | "主要聯絡資訊"
  | "Email"
  | "聯絡日期"
  | "聯絡窗口"
  | "聯絡狀態"
  | "贊助內容";

/** 需要公關長特別看的欄位，畫面上要明顯標出 */
export function flaggedFields(row: WashedRow): Set<ReviewField> {
  const flagged = new Set<ReviewField>();
  if (!row.vendorName) flagged.add("廠商名稱");
  if (row.contactMethod === null) flagged.add("主要聯絡方式");
  if (row.contactMethod !== null && row.contactMethod !== "Email" && !row.contactInfo) flagged.add("主要聯絡資訊");
  const emailMatters = row.contactMethod === "Email" || row.email.check !== "missing";
  if (row.email.check !== "valid" && emailMatters) flagged.add("Email");
  if (row.date.check !== "valid") flagged.add("聯絡日期");
  if (row.contactValidity === "replaced") flagged.add("聯絡窗口");
  if (!row.status.adoptable) flagged.add("聯絡狀態");
  if (row.interpretationNotes.length > 0) flagged.add("贊助內容");
  return flagged;
}

export interface ReviewProgress {
  pending: number;
  confirmed: number;
  skipped: number;
}

export function reviewProgress(rows: WashedRow[], actions: ReviewActions): ReviewProgress {
  const progress: ReviewProgress = { pending: 0, confirmed: 0, skipped: 0 };
  for (const row of rows) {
    const action = actions[row.rowNumber];
    if (action === undefined) progress.pending += 1;
    else if (action === "skipped") progress.skipped += 1;
    else progress.confirmed += 1;
  }
  return progress;
}

/** 疑似重複群組代號 → 公關長選的合併決定；沒有出現＝還沒決定 */
export type MergeDecisions = Partial<Record<string, MergeDecision>>;

/** 設定或清除（decision 為 undefined）某一組的合併決定；不認得的群組或選項會被忽略 */
export function applyMergeDecision(
  rows: WashedRow[],
  decisions: MergeDecisions,
  group: string,
  decision: MergeDecision | undefined,
): MergeDecisions {
  if (!rows.some((row) => row.duplicateGroup === group)) return decisions;
  if (decision !== undefined && !(MERGE_DECISIONS as readonly string[]).includes(decision)) return decisions;
  const next = { ...decisions };
  if (decision === undefined) delete next[group];
  else next[group] = decision;
  return next;
}

/** 已確認的列轉成⑤舊資料暫存的 32 欄（STAGING_COLUMNS 的順序）。阻擋的列一律不會出現。 */
export function stagingRowsFor(
  rows: WashedRow[],
  actions: ReviewActions,
  context: StagingContext,
  mergeDecisions: MergeDecisions = {},
): StagingCell[][] {
  return rows
    .filter((row) => {
      const action = actions[row.rowNumber];
      return (action === "accepted" || action === "edited") && canConfirm(row);
    })
    .map((row) =>
      toStagingRow(row, context, row.duplicateGroup ? (mergeDecisions[row.duplicateGroup] ?? null) : null),
    );
}
