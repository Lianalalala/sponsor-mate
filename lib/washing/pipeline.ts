// Data washing machine 的主流程（結構化資料）：
// 舊表 → 排除空白列與完全相同的列 → 逐格清洗 → 找疑似重複 → 決定匯入處置。
// 這裡不連任何外部服務，也不修改傳入的原始資料。

import { checkContact, resolveContactMethod, type ContactMethod } from "./contact.ts";
import { cleanDate, type CleanDate } from "./date.ts";
import {
  analyzeDuplicateGroup,
  findDuplicateGroups,
  type DuplicateAnalysis,
  type DuplicateMember,
} from "./duplicates.ts";
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

// 匯入處置（與資料表⑤「匯入處置」下拉選單一致，D-016）。規則都由程式計算：
// 1. 缺廠商名稱，或不符合聯絡方式規則（contact.ts 的 checkContact，D-024）
//    → 阻擋正式匯入（補好資料、重新檢查通過才能確認）
// 2. 廠商要求停止聯絡 → 可暫存／禁止聯絡
// 3. 疑似重複、主要聯絡方式待確認、舊狀態不能直接採用、窗口已換、數量或金額不確定 → 待人工覆核
// 4. 其他 → 可暫存
export const IMPORT_DISPOSITIONS = [
  "可暫存",
  "可暫存／禁止聯絡",
  "待人工覆核",
  "阻擋正式匯入",
] as const;

export type ImportDisposition = (typeof IMPORT_DISPOSITIONS)[number];

export interface WashedRow {
  rowNumber: number;
  raw: Record<string, string>;
  legacyId: string;
  vendorName: string | null;
  /** 舊表的聯絡資料原文；判斷「完全沒有聯絡資訊」用 */
  contactRaw: string;
  /** 主要聯絡方式（D-024）；null＝待確認 */
  contactMethod: ContactMethod | null;
  /** 主要聯絡資訊；主要聯絡方式是 Email 時為空字串 */
  contactInfo: string;
  /** 聯絡備註，例如「要跟上一屆要 LINE」；清洗時是空的，由公關長填 */
  contactNote: string;
  email: CleanEmail;
  date: CleanDate;
  eventLabel: string;
  /** 舊表的狀態原文；重新檢查時用來重算 status */
  statusRaw: string;
  /** 舊活動不自動對應到現行活動，由幹部之後指定 */
  officialEventId: null;
  status: StatusResult;
  vendorStopContact: boolean;
  contactValidity: ContactValidity;
  interpretation: RowInterpretation;
  duplicateGroup: string | null;
  /** 疑似重複群組的建議與證據（整組共用同一份）；不是疑似重複就是 null */
  duplicate: DuplicateAnalysis | null;
  owner: string;
  /** 舊資料的「已寄」都不是 Gmail API 成功紀錄 */
  countsAsGmailSent: false;
  /** AI 拆解結果被防呆捨棄或標為不確定的紀錄 */
  interpretationNotes: string[];
  disposition: ImportDisposition;
  /** 決定這個處置的原因（阻擋或需要人工覆核的理由） */
  reviewReasons: string[];
  /** 不影響處置、但資料上有問題的紀錄 */
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

export function cleanVendorName(raw: string): string | null {
  const name = raw.replace(/[​-‍﻿]/g, "").trim();
  return name === "" || /^[-—–]+$/.test(name) ? null : name;
}

/** 舊狀態 → ③的狀態候選。沒有廠商名稱時，任何狀態都不能直接採用。 */
export function deriveStatus(
  statusRaw: string,
  vendorName: string | null,
  vendorStopContact: boolean,
): StatusResult {
  const base = interpretStatus(statusRaw);
  return {
    ...base,
    adoptable: base.adoptable && vendorName !== null,
    decision: vendorStopContact ? "停止追蹤" : base.decision,
  };
}

const UNCERTAIN_AMOUNT_NOTE = "原文的數量或金額不確定，需人工確認";

/** 處置相關欄位以外的部分；重新檢查時只會改到 finalizeRow 算出來的欄位 */
export type RowFacts = Omit<WashedRow, "disposition" | "reviewReasons" | "dataNotes">;

/** 依 RowFacts 算出匯入處置與理由。洗整張表和「編輯後重新檢查」共用這一份規則。 */
export function finalizeRow(facts: RowFacts): WashedRow {
  const blockReasons: string[] = [];
  if (!facts.vendorName) blockReasons.push("缺廠商名稱，不可建立正式廠商 ID");
  const contact = checkContact(facts);
  if (contact.block) blockReasons.push(contact.block);

  const reviewReasons: string[] = [];
  if (contact.review) reviewReasons.push(contact.review);
  if (facts.duplicateGroup) {
    const suggestion = facts.duplicate?.suggestion;
    reviewReasons.push(
      suggestion
        ? `疑似重複（${facts.duplicateGroup}），建議「${suggestion}」，需公關長決定`
        : `疑似重複（${facts.duplicateGroup}），名稱不完全相同，需公關長決定要不要合併`,
    );
    const mismatched = facts.duplicate?.mismatchedFields ?? [];
    if (mismatched.length > 0) reviewReasons.push(`同組欄位不一致：${mismatched.join("、")}`);
  }
  if (!facts.status.adoptable) {
    reviewReasons.push(`舊狀態不能直接採用：${facts.status.reason ?? facts.status.label}`);
  }
  if (facts.contactValidity === "replaced") reviewReasons.push("窗口已更換，需取得新窗口");
  const uncertainAmount = facts.interpretationNotes.includes(UNCERTAIN_AMOUNT_NOTE);
  if (uncertainAmount) reviewReasons.push(UNCERTAIN_AMOUNT_NOTE);

  const dataNotes = facts.interpretationNotes.filter((note) => note !== UNCERTAIN_AMOUNT_NOTE);
  if (facts.date.check !== "valid" && facts.date.check !== "missing") dataNotes.push(facts.date.note);
  if (facts.vendorStopContact) dataNotes.push("廠商要求停止聯絡，禁止任何後續寄送");
  const emailProblem = facts.email.check !== "valid" && facts.email.check !== "missing";
  if (emailProblem && facts.contactMethod !== null && facts.contactMethod !== "Email") {
    dataNotes.push(`Email ${facts.email.note}；要寄信前得先補好 Email`);
  }

  let disposition: ImportDisposition;
  let reasons: string[];
  if (blockReasons.length > 0) {
    disposition = "阻擋正式匯入";
    reasons = [...blockReasons, ...reviewReasons];
  } else if (facts.vendorStopContact) {
    disposition = "可暫存／禁止聯絡";
    reasons = reviewReasons;
  } else if (reviewReasons.length > 0) {
    disposition = "待人工覆核";
    reasons = reviewReasons;
  } else {
    disposition = "可暫存";
    reasons = [];
  }

  return { ...facts, disposition, reviewReasons: reasons, dataNotes };
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
    const vendorStopContact = detectStopContact(statusRaw, notesRaw);
    const status = deriveStatus(statusRaw, vendorName, vendorStopContact);

    const raw: Record<string, string> = {};
    table.headers.forEach((header, column) => {
      raw[header] = cells[column] ?? "";
    });

    const contactChoice = resolveContactMethod(
      email,
      guarded.value.contactMethod,
      guarded.value.contactInfo,
    );

    return {
      rowNumber,
      raw,
      legacyId: readField(cells, mapping, "legacyId"),
      vendorName,
      contactRaw,
      contactMethod: contactChoice.method,
      contactInfo: contactChoice.info,
      contactNote: "",
      email,
      date,
      eventLabel: readField(cells, mapping, "eventLabel"),
      statusRaw,
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
      interpretationNotes: guarded.reviewReasons,
    };
  });

  const groups = findDuplicateGroups(
    partial.map((row) => ({
      id: row.rowNumber,
      vendorName: row.vendorName,
      email: row.email.value,
    })),
  );

  const grouped = partial.map((row) => ({
    ...row,
    duplicateGroup: groups.get(row.rowNumber) ?? null,
    duplicate: null as DuplicateAnalysis | null,
  }));
  const rows = withDuplicateAnalysis(grouped).map(finalizeRow);

  return { rows, excluded };
}

type DuplicateFacts = Pick<
  RowFacts,
  | "rowNumber"
  | "vendorName"
  | "email"
  | "contactMethod"
  | "contactInfo"
  | "eventLabel"
  | "interpretation"
  | "owner"
  | "date"
  | "duplicateGroup"
>;

function duplicateMember(row: DuplicateFacts): DuplicateMember {
  const { interpretation } = row;
  const text = (value: string | number | null) => (value === null ? null : String(value));
  return {
    id: row.rowNumber,
    vendorName: row.vendorName,
    email: row.email.value,
    eventLabel: row.eventLabel,
    compareFields: {
      主要聯絡方式: row.contactMethod,
      主要聯絡資訊: row.contactInfo,
      Email: row.email.value,
      聯絡窗口: interpretation.contactPerson,
      其他聯絡管道: interpretation.otherChannels,
      原負責人: row.owner,
    },
    sameEventFields: {
      聯絡日期: row.date.iso,
      現金金額: text(interpretation.cashNtd),
      實物品項: interpretation.item,
      實物數量: text(interpretation.quantity),
      單位: interpretation.unit,
    },
  };
}

/** 依目前的資料重新分析每個疑似重複群組；群組本身不變，只更新建議、證據和不一致欄位 */
export function withDuplicateAnalysis<T extends DuplicateFacts & { duplicate: DuplicateAnalysis | null }>(
  rows: T[],
): T[] {
  const members = new Map<string, DuplicateMember[]>();
  for (const row of rows) {
    if (!row.duplicateGroup) continue;
    members.set(row.duplicateGroup, [...(members.get(row.duplicateGroup) ?? []), duplicateMember(row)]);
  }
  const analyses = new Map(
    [...members].map(([group, list]) => [group, analyzeDuplicateGroup(group, list)] as const),
  );
  return rows.map((row) => ({
    ...row,
    duplicate: row.duplicateGroup ? (analyses.get(row.duplicateGroup) ?? null) : null,
  }));
}

/** 編輯某一列之後，同組其他列的建議也可能改變，所以整份重新分析、重算處置 */
export function refreshDuplicates(rows: WashedRow[]): WashedRow[] {
  return withDuplicateAnalysis(rows).map(finalizeRow);
}
