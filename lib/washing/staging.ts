// 資料表「⑤舊資料暫存」的一列（D-025）：⑤是原始資料留底＋稍後處理的存檔，由系統管理。
// 公關長在 /import 預覽頁一次處理完，確認的列直接寫進①③；
// 每一列都會存一份到⑤，「確認狀態」記已寫入／待處理／不匯入。待處理的列下次打開 /import 會讀回來。
//
// 寫入 Google Sheets 時必須用 valueInputOption: RAW，
// 否則舊資料裡以 = 開頭的內容會被當成公式執行。

import { isContactMethod } from "./contact.ts";
import { cleanDate, type CleanDate, type DateCheck } from "./date.ts";
import type { MergeDecision } from "./duplicates.ts";
import { cleanEmail, type CleanEmail, type EmailCheck } from "./email.ts";
import { EMPTY_INTERPRETATION } from "./interpretation.ts";
import { deriveStatus, finalizeRow, type WashedRow } from "./pipeline.ts";
import { statusRawFromLabel, type ContactValidity } from "./status.ts";

export const STAGING_COLUMNS = [
  "暫存ID",
  "匯入批次",
  "來源檔名",
  "原始列號",
  "舊序",
  "匯入處置",
  "待確認原因",
  "廠商名稱",
  "主要聯絡方式",
  "主要聯絡資訊",
  "Email",
  "Email檢核",
  "聯絡窗口",
  "窗口有效性",
  "其他聯絡管道",
  "聯絡備註",
  "聯絡日期",
  "日期檢核",
  "舊活動標籤",
  "對應活動ID",
  "聯絡狀態候選",
  "狀態可直接採用",
  "處理決策候選",
  "廠商停止聯絡",
  "現金金額（NTD）",
  "實物品項",
  "實物數量",
  "單位",
  "疑似重複群組",
  "合併決定",
  "原負責人",
  "原始資料",
  "確認狀態",
  "建立時間",
  "建立人",
] as const;

export type StagingColumn = (typeof STAGING_COLUMNS)[number];
export type StagingCell = string | number;

export interface StagingContext {
  batchId: string;
  sourceName: string;
  createdAt: string;
  createdBy: string;
}

const CONTACT_VALIDITY_LABEL: Record<ContactValidity, string> = {
  not_provided: "未提供",
  unverified: "未驗證",
  replaced: "已換窗口；不得直接使用",
};

const yesNo = (value: boolean): string => (value ? "是" : "否");

/** ⑤「確認狀態」下拉選單的選項 */
export const CONFIRM_STATUSES = ["已寫入", "待處理", "不匯入"] as const;
export type ConfirmStatus = (typeof CONFIRM_STATUSES)[number];

export interface StagingArchive {
  /** 公關長在預覽頁選的合併決定；沒選就是空白。程式的建議只寫在「待確認原因」 */
  mergeDecision?: MergeDecision | null;
  /** 對應到②的活動ID（含這次新建的歷史活動） */
  eventId?: string;
  confirmStatus?: ConfirmStatus;
}

export function stagingIdFor(row: WashedRow, context: StagingContext): string {
  return row.stagingId ?? `${context.batchId}-${row.rowNumber}`;
}

/** 依 STAGING_COLUMNS 的順序回傳一列 */
export function toStagingRow(
  row: WashedRow,
  context: StagingContext,
  archive: StagingArchive = {},
): StagingCell[] {
  const { interpretation } = row;
  const cells: Record<StagingColumn, StagingCell> = {
    暫存ID: stagingIdFor(row, context),
    匯入批次: context.batchId,
    來源檔名: context.sourceName,
    原始列號: row.rowNumber,
    舊序: row.legacyId,
    匯入處置: row.disposition,
    待確認原因: [...row.reviewReasons, ...row.dataNotes].join("；"),
    廠商名稱: row.vendorName ?? "",
    主要聯絡方式: row.contactMethod ?? "",
    主要聯絡資訊: row.contactInfo,
    Email: row.email.value ?? "",
    Email檢核: row.email.note,
    聯絡窗口: interpretation.contactPerson ?? "",
    窗口有效性: CONTACT_VALIDITY_LABEL[row.contactValidity],
    其他聯絡管道: interpretation.otherChannels ?? "",
    聯絡備註: row.contactNote,
    聯絡日期: row.date.iso ?? "",
    日期檢核: row.date.note,
    舊活動標籤: row.eventLabel,
    對應活動ID: archive.eventId ?? "",
    聯絡狀態候選: row.status.label,
    狀態可直接採用: yesNo(row.status.adoptable),
    處理決策候選: row.status.decision,
    廠商停止聯絡: yesNo(row.vendorStopContact),
    "現金金額（NTD）": interpretation.cashNtd ?? "",
    實物品項: interpretation.item ?? "",
    實物數量: interpretation.quantity ?? "",
    單位: interpretation.unit ?? "",
    疑似重複群組: row.duplicateGroup ?? "",
    合併決定: row.duplicateGroup ? (archive.mergeDecision ?? "") : "",
    原負責人: row.owner,
    原始資料: JSON.stringify(row.raw),
    確認狀態: archive.confirmStatus ?? "待處理",
    建立時間: context.createdAt,
    建立人: context.createdBy,
  };
  return STAGING_COLUMNS.map((column) => cells[column]);
}

const VALIDITY_FROM_LABEL = new Map(
  Object.entries(CONTACT_VALIDITY_LABEL).map(([key, label]) => [label, key as ContactValidity]),
);

function emailFromStaging(value: string, note: string): CleanEmail {
  if (value) return cleanEmail(value);
  const rules: [string, EmailCheck][] = [
    ["格式無效（缺@）", "invalid_no_at"],
    ["格式無效", "invalid_format"],
    ["同一格有多個", "multiple"],
  ];
  const check = rules.find(([prefix]) => note.startsWith(prefix))?.[1] ?? "missing";
  const candidates = check === "multiple" ? (note.split("：")[1] ?? "").split("、").filter(Boolean) : [];
  return { value: null, check, candidates, note: note || "沒有 Email" };
}

function dateFromStaging(iso: string, note: string): CleanDate {
  if (iso) return cleanDate(iso);
  const rules: [string, DateCheck][] = [
    ["日期缺漏", "missing"],
    ["缺年份", "missing_year"],
    ["兩位數年份", "ambiguous_year"],
    ["日期無效", "invalid"],
  ];
  const check = rules.find(([prefix]) => note.startsWith(prefix))?.[1] ?? "unrecognized";
  return { iso: null, check, note: note || "日期缺漏" };
}

const numberOrNull = (value: string): number | null => (value.trim() === "" ? null : Number(value));
const textOrNull = (value: string): string | null => (value.trim() === "" ? null : value);

/**
 * 把⑤裡「待處理」的一列讀回來，讓公關長在 /import 接著處理（D-025）。
 * 只用⑤存的欄位重算處置；疑似重複要跟這一批放在一起後用 regroupDuplicates 重新分組。
 */
export function fromStagingRow(cells: StagingCell[]): WashedRow {
  const get = (column: StagingColumn) => String(cells[STAGING_COLUMNS.indexOf(column)] ?? "");
  const vendorStopContact = get("廠商停止聯絡") === "是";
  const vendorName = textOrNull(get("廠商名稱"));
  const statusRaw = statusRawFromLabel(get("聯絡狀態候選"));
  const method = get("主要聯絡方式");
  const email = emailFromStaging(get("Email"), get("Email檢核"));
  // ⑤沒有存聯絡資料的原文，用拆好的值和 Email 檢核紀錄代替（只用來判斷「有沒有聯絡資料」）
  const contactRaw = [get("Email"), get("主要聯絡資訊"), get("聯絡窗口"), get("其他聯絡管道")]
    .filter(Boolean)
    .join("；") || (email.check === "missing" ? "" : email.note);
  const reasons = get("待確認原因").split("；").filter(Boolean);
  let raw: Record<string, string> = {};
  try {
    raw = JSON.parse(get("原始資料")) as Record<string, string>;
  } catch {
    raw = {};
  }

  return finalizeRow({
    rowNumber: Number(get("原始列號")) || 0,
    stagingId: get("暫存ID"),
    raw,
    legacyId: get("舊序"),
    vendorName,
    contactRaw,
    contactMethod: isContactMethod(method) ? method : null,
    contactInfo: get("主要聯絡資訊"),
    contactNote: get("聯絡備註"),
    email,
    date: dateFromStaging(get("聯絡日期"), get("日期檢核")),
    eventLabel: get("舊活動標籤"),
    statusRaw,
    officialEventId: null,
    status: deriveStatus(statusRaw, vendorName, vendorStopContact),
    vendorStopContact,
    contactValidity: VALIDITY_FROM_LABEL.get(get("窗口有效性")) ?? "not_provided",
    interpretation: {
      ...EMPTY_INTERPRETATION,
      contactPerson: textOrNull(get("聯絡窗口")),
      otherChannels: textOrNull(get("其他聯絡管道")),
      cashNtd: numberOrNull(get("現金金額（NTD）")),
      item: textOrNull(get("實物品項")),
      quantity: numberOrNull(get("實物數量")),
      unit: textOrNull(get("單位")),
    },
    duplicateGroup: null,
    duplicate: null,
    owner: get("原負責人"),
    countsAsGmailSent: false,
    interpretationNotes: reasons.filter(
      (reason) => reason.startsWith("AI 的") || reason === "原文的數量或金額不確定，需人工確認",
    ),
  });
}
