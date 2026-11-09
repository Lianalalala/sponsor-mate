// Data washing machine 的主流程（結構化資料）：
// 舊表 → 排除空白列與完全相同的列 → 逐格清洗 → 找疑似重複 → 決定匯入處置。
// 這裡不連任何外部服務，也不修改傳入的原始資料。

import { cleanDate, type CleanDate } from "./date.ts";
import { findDuplicateGroups } from "./duplicates.ts";
import { cleanEmail, type CleanEmail } from "./email.ts";
import {
  EMPTY_INTERPRETATION,
  guardInterpretation,
  type RowInterpretation,
} from "./interpretation.ts";
import {
  assessContactValidity,
  detectStopContact,
  interpretStatus,
  type ContactValidity,
  type StatusResult,
} from "./status.ts";

export type WashField =
  | "legacyId"
  | "vendorName"
  | "contact"
  | "contactDate"
  | "status"
  | "sponsorship"
  | "eventLabel"
  | "owner"
  | "notes";

/** 每個欄位對應到舊表的哪幾欄（0 起算）。由 AI 建議、幹部確認後傳入。 */
export type ColumnMapping = Partial<Record<WashField, number[]>>;

export interface RawTable {
  headers: string[];
  rows: string[][];
  /** 第一筆資料在原檔的列號，預設 2（第 1 列是標題） */
  firstDataRowNumber?: number;
}

// 只有疑似重複和缺廠商名稱需要人處理；其他狀況照寫入，問題記在 dataNotes，
// 沒有 Email、舊窗口這類問題由寄前檢核擋下。
export type ImportDisposition =
  | "可寫入"
  | "可寫入／禁止聯絡"
  | "待確認合併"
  | "無法寫入";

export interface WashedRow {
  rowNumber: number;
  raw: Record<string, string>;
  legacyId: string;
  vendorName: string | null;
  email: CleanEmail;
  date: CleanDate;
  eventLabel: string;
  /** 舊活動不自動對應到現行活動，由幹部之後指定 */
  officialEventId: null;
  status: StatusResult;
  vendorStopContact: boolean;
  contactValidity: ContactValidity;
  interpretation: RowInterpretation;
  duplicateGroup: string | null;
  owner: string;
  /** 舊資料的「已寄」都不是 Gmail API 成功紀錄 */
  countsAsGmailSent: false;
  disposition: ImportDisposition;
  /** 需要公關長處理的原因 */
  reviewReasons: string[];
  /** 不擋寫入、但資料上有問題的紀錄 */
  dataNotes: string[];
}

export type ExclusionReason = "blank_row" | "exact_duplicate";

export interface ExcludedRow {
  rowNumber: number;
  reason: ExclusionReason;
  duplicateOf?: number;
}

export interface WashResult {
  rows: WashedRow[];
  excluded: ExcludedRow[];
}

const REQUIRED_FIELDS: WashField[] = ["vendorName"];

function validateMapping(table: RawTable, mapping: ColumnMapping): void {
  for (const field of REQUIRED_FIELDS) {
    if (!mapping[field]?.length) {
      throw new Error(`欄位對應缺少必要欄位：${field}`);
    }
  }
  const used = new Set<number>();
  for (const [field, columns] of Object.entries(mapping)) {
    for (const column of columns ?? []) {
      if (!Number.isInteger(column) || column < 0 || column >= table.headers.length) {
        throw new Error(`欄位對應超出範圍：${field} → 第 ${column} 欄`);
      }
      if (used.has(column)) {
        throw new Error(`同一欄被對應到多個欄位：第 ${column} 欄`);
      }
      used.add(column);
    }
  }
}

function readField(row: string[], mapping: ColumnMapping, field: WashField): string {
  return (mapping[field] ?? [])
    .map((column) => row[column] ?? "")
    .filter((cell) => cell.trim() !== "")
    .join("；");
}

function cleanVendorName(raw: string): string | null {
  const name = raw.replace(/[​-‍﻿]/g, "").trim();
  return name === "" || /^[-—–]+$/.test(name) ? null : name;
}

function decideDisposition(input: {
  vendorName: string | null;
  vendorStopContact: boolean;
  duplicateGroup: string | null;
}): ImportDisposition {
  if (!input.vendorName) return "無法寫入";
  if (input.duplicateGroup) return "待確認合併";
  return input.vendorStopContact ? "可寫入／禁止聯絡" : "可寫入";
}

export function washTable(
  table: RawTable,
  mapping: ColumnMapping,
  interpretations: ReadonlyMap<number, RowInterpretation> = new Map(),
): WashResult {
  validateMapping(table, mapping);

  const firstRow = table.firstDataRowNumber ?? 2;
  const excluded: ExcludedRow[] = [];
  const seen = new Map<string, number>();
  const kept: { rowNumber: number; cells: string[] }[] = [];

  table.rows.forEach((cells, index) => {
    const rowNumber = firstRow + index;
    const normalized = table.headers.map((_, column) => (cells[column] ?? "").trim());
    if (normalized.every((cell) => cell === "")) {
      excluded.push({ rowNumber, reason: "blank_row" });
      return;
    }
    const key = normalized.join("\u0000");
    const firstSeen = seen.get(key);
    if (firstSeen !== undefined) {
      excluded.push({ rowNumber, reason: "exact_duplicate", duplicateOf: firstSeen });
      return;
    }
    seen.set(key, rowNumber);
    kept.push({ rowNumber, cells });
  });

  const partial = kept.map(({ rowNumber, cells }) => {
    const contactRaw = readField(cells, mapping, "contact");
    const statusRaw = readField(cells, mapping, "status");
    const notesRaw = readField(cells, mapping, "notes");
    const sponsorshipRaw = readField(cells, mapping, "sponsorship");

    const vendorName = cleanVendorName(readField(cells, mapping, "vendorName"));
    const email = cleanEmail(contactRaw);
    const date = cleanDate(readField(cells, mapping, "contactDate"));
    const guarded = guardInterpretation(
      interpretations.get(rowNumber) ?? EMPTY_INTERPRETATION,
      contactRaw,
      sponsorshipRaw,
    );
    const baseStatus = interpretStatus(statusRaw);
    const vendorStopContact = detectStopContact(statusRaw, notesRaw);

    const status: StatusResult = {
      ...baseStatus,
      adoptable: baseStatus.adoptable && vendorName !== null,
      decision: vendorStopContact ? "停止追蹤" : baseStatus.decision,
    };

    const raw: Record<string, string> = {};
    table.headers.forEach((header, column) => {
      raw[header] = cells[column] ?? "";
    });

    return {
      rowNumber,
      raw,
      legacyId: readField(cells, mapping, "legacyId"),
      vendorName,
      email,
      date,
      eventLabel: readField(cells, mapping, "eventLabel"),
      officialEventId: null,
      status,
      vendorStopContact,
      contactValidity: assessContactValidity(
        guarded.value.contactPerson,
        contactRaw,
        statusRaw,
      ),
      interpretation: guarded.value,
      owner: readField(cells, mapping, "owner"),
      countsAsGmailSent: false as const,
      guardReasons: guarded.reviewReasons,
    };
  });

  const groups = findDuplicateGroups(
    partial.map((row) => ({
      id: row.rowNumber,
      vendorName: row.vendorName,
      email: row.email.value,
    })),
  );

  const rows: WashedRow[] = partial.map(({ guardReasons, ...row }) => {
    const duplicateGroup = groups.get(row.rowNumber) ?? null;
    const reviewReasons: string[] = [];
    if (!row.vendorName) reviewReasons.push("缺廠商名稱，不可建立正式廠商 ID");
    if (duplicateGroup) reviewReasons.push(`疑似重複（${duplicateGroup}），需幹部確認才能合併`);

    const dataNotes = [...guardReasons];
    if (row.email.check !== "valid") dataNotes.push(row.email.note);
    if (row.date.check !== "valid" && row.date.check !== "missing") dataNotes.push(row.date.note);
    if (row.contactValidity === "replaced") dataNotes.push("窗口已更換，需取得新窗口");
    if (row.status.reason) dataNotes.push(row.status.reason);
    if (row.vendorStopContact) dataNotes.push("廠商要求停止聯絡，禁止任何後續寄送");

    return {
      ...row,
      duplicateGroup,
      reviewReasons,
      dataNotes,
      disposition: decideDisposition({
        vendorName: row.vendorName,
        vendorStopContact: row.vendorStopContact,
        duplicateGroup,
      }),
    };
  });

  return { rows, excluded };
}
