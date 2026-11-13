// 把洗好的資料轉成資料表「⑤舊資料暫存」的一列。
// 公關長在暫存區對應活動、決定合併後，才會寫進①廠商、③往來紀錄。
//
// 寫入 Google Sheets 時必須用 valueInputOption: RAW，
// 否則舊資料裡以 = 開頭的內容會被當成公式執行。

import type { MergeDecision } from "./duplicates.ts";
import type { WashedRow } from "./pipeline.ts";
import type { ContactValidity } from "./status.ts";

export const STAGING_COLUMNS = [
  "暫存ID",
  "匯入批次",
  "來源檔名",
  "原始列號",
  "舊序",
  "匯入處置",
  "待確認原因",
  "廠商名稱",
  "Email",
  "Email檢核",
  "聯絡窗口",
  "窗口有效性",
  "其他聯絡管道",
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

/**
 * 依 STAGING_COLUMNS 的順序回傳一列。
 * 「合併決定」填公關長在預覽頁選的（MERGE_DECISIONS），沒選就是空白；程式的建議只寫在「待確認原因」。
 */
export function toStagingRow(
  row: WashedRow,
  context: StagingContext,
  mergeDecision: MergeDecision | null = null,
): StagingCell[] {
  const { interpretation } = row;
  const cells: Record<StagingColumn, StagingCell> = {
    暫存ID: `${context.batchId}-${row.rowNumber}`,
    匯入批次: context.batchId,
    來源檔名: context.sourceName,
    原始列號: row.rowNumber,
    舊序: row.legacyId,
    匯入處置: row.disposition,
    待確認原因: [...row.reviewReasons, ...row.dataNotes].join("；"),
    廠商名稱: row.vendorName ?? "",
    Email: row.email.value ?? "",
    Email檢核: row.email.note,
    聯絡窗口: interpretation.contactPerson ?? "",
    窗口有效性: CONTACT_VALIDITY_LABEL[row.contactValidity],
    其他聯絡管道: interpretation.otherChannels ?? "",
    聯絡日期: row.date.iso ?? "",
    日期檢核: row.date.note,
    舊活動標籤: row.eventLabel,
    對應活動ID: "",
    聯絡狀態候選: row.status.label,
    狀態可直接採用: yesNo(row.status.adoptable),
    處理決策候選: row.status.decision,
    廠商停止聯絡: yesNo(row.vendorStopContact),
    "現金金額（NTD）": interpretation.cashNtd ?? "",
    實物品項: interpretation.item ?? "",
    實物數量: interpretation.quantity ?? "",
    單位: interpretation.unit ?? "",
    疑似重複群組: row.duplicateGroup ?? "",
    合併決定: row.duplicateGroup ? (mergeDecision ?? "") : "",
    原負責人: row.owner,
    原始資料: JSON.stringify(row.raw),
    確認狀態: "待確認",
    建立時間: context.createdAt,
    建立人: context.createdBy,
  };
  return STAGING_COLUMNS.map((column) => cells[column]);
}
