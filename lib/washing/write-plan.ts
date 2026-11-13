// 寫入計畫（D-025）：公關長在 /import 預覽頁一次處理完，確認的列直接寫進①廠商、③往來紀錄；
// 選「建立為歷史活動」的在②新增一列；每一列都存一份到⑤留底，稍後處理的標「待處理」。
//
// 這裡只算出「要寫什麼」，不連任何外部服務。②現行活動、①既有廠商、③既有往來紀錄由呼叫端傳入，
// 之後接上 Sheets 讀寫時只換資料來源。真的寫入前，伺服器端要用同一份 reviewImport 再算一次，
// 不能只相信瀏覽器送來的結果。

import { checkContact, type ContactMethod } from "./contact.ts";
import { looksLikeSameVendor, vendorNameKey, type MergeDecision } from "./duplicates.ts";
import type { WashedRow } from "./pipeline.ts";
import type { MergeDecisions } from "./review.ts";
import {
  stagingIdFor,
  toStagingRow,
  type ConfirmStatus,
  type StagingCell,
  type StagingColumn,
  type StagingContext,
} from "./staging.ts";

// 欄位順序照共用資料夾「sponsor-mate 資料表骨架」；①含 D-024 新增的三欄
export const VENDOR_COLUMNS = [
  "廠商ID",
  "廠商名稱",
  "產業類別",
  "聯絡窗口",
  "窗口職稱",
  "主要聯絡方式",
  "主要聯絡資訊",
  "Email",
  "電話",
  "其他聯絡管道",
  "聯絡備註",
  "廠商主動要求停止聯絡",
  "備註",
  "資料來源",
  "最後更新時間",
  "最後更新人",
] as const;

export const EVENT_COLUMNS = [
  "活動ID",
  "活動名稱",
  "活動日期",
  "招商截止日",
  "活動簡介",
  "合作需求",
  "企劃書版本",
  "企劃書連結",
  "活動狀態",
  "資料來源",
  "最後更新時間",
  "最後更新人",
] as const;

export const RECORD_COLUMNS = [
  "往來ID",
  "廠商ID",
  "廠商名稱",
  "活動ID",
  "活動名稱",
  "負責組員",
  "聯絡狀態",
  "處理決策",
  "寄信次數",
  "最後寄信時間",
  "合作備註",
  "合作承諾",
  "成果連結",
  "待補資料",
  "資料來源",
  "最後更新時間",
  "最後更新人",
  "現金金額（NTD）",
  "實物品項",
  "實物數量",
  "單位",
] as const;

export type VendorColumn = (typeof VENDOR_COLUMNS)[number];
export type EventColumn = (typeof EVENT_COLUMNS)[number];
export type RecordColumn = (typeof RECORD_COLUMNS)[number];
export type SheetRow<C extends string> = Record<C, string | number>;

/** ②「活動狀態」新增的選項：舊資料匯入時補建的活動 */
export const HISTORY_EVENT_STATUS = "歷史";
const SOURCE = "Excel 匯入";

export interface ExistingVendor {
  id: string;
  name: string;
  email: string | null;
  contactMethod: ContactMethod | null;
  contactInfo: string;
  contactPerson: string | null;
  otherChannels: string | null;
  stopContact: boolean;
}

export interface ExistingEvent {
  id: string;
  name: string;
  /** 籌備中／招商中／已結束／歷史 */
  status: string;
}

export interface ExistingRecord {
  id: string;
  vendorId: string;
  eventId: string;
}

export interface ImportContext {
  vendors: ExistingVendor[];
  events: ExistingEvent[];
  records: ExistingRecord[];
  batch: StagingContext;
}

/** 每列的動作：確認／稍後處理（存進⑤待處理）／不匯入。沒有動作＝還沒處理 */
export type RowAction = "confirm" | "later" | "skip";

export type EventChoice = { kind: "existing"; eventId: string } | { kind: "history"; name: string };

/** vendorMatch 的值：①既有廠商的 ID，或 NEW_VENDOR（不同廠商，新增一家） */
export const NEW_VENDOR = "new";

export type VendorField = "廠商名稱" | "主要聯絡方式" | "Email" | "聯絡窗口" | "其他聯絡管道";
export const VENDOR_FIELDS: VendorField[] = ["廠商名稱", "主要聯絡方式", "Email", "聯絡窗口", "其他聯絡管道"];

export interface ImportChoices {
  actions: Partial<Record<number, RowAction>>;
  /** 依舊活動名稱一次對應（頁首） */
  eventByLabel: Partial<Record<string, EventChoice>>;
  /** 個別列另外指定，優先於 eventByLabel */
  eventByRow: Partial<Record<number, EventChoice>>;
  mergeDecisions: MergeDecisions;
  /** 「只留一筆」時留下哪一列；沒選就留資料最完整的那筆 */
  keepRow: Partial<Record<string, number>>;
  /** 廠商單位 → ①既有廠商 ID 或 NEW_VENDOR */
  vendorMatch: Partial<Record<string, string>>;
  /** 廠商單位 → 不一致的欄位選了哪個值（FieldOption.value） */
  fieldChoices: Partial<Record<string, Partial<Record<VendorField, string>>>>;
}

export const EMPTY_CHOICES: ImportChoices = {
  actions: {},
  eventByLabel: {},
  eventByRow: {},
  mergeDecisions: {},
  keepRow: {},
  vendorMatch: {},
  fieldChoices: {},
};

export type BlockerKind =
  | "廠商名稱"
  | "主要聯絡方式"
  | "主要聯絡資訊"
  | "Email"
  | "對應活動"
  | "合併決定"
  | "既有廠商"
  | "欄位不一致"
  | "往來紀錄重複";

/** 會擋住寫入的問題；畫面上只有這些會標成警告 */
export interface Blocker {
  kind: BlockerKind;
  message: string;
}

export interface FieldOption {
  value: string;
  label: string;
  /** 這個值來自哪裡，例如「第 4 列」「①既有」 */
  from: string[];
}

export interface FieldConflict {
  field: VendorField;
  options: FieldOption[];
  chosen: string | null;
}

/** 會寫成①同一家廠商的列 */
export interface VendorUnit {
  key: string;
  rowNumbers: number[];
  /** ①裡疑似同一家的既有廠商 */
  candidates: ExistingVendor[];
  /** 既有廠商 ID、NEW_VENDOR，或 null（有候選但還沒選） */
  match: string | null;
  conflicts: FieldConflict[];
}

export interface RowReview {
  rowNumber: number;
  /** 實際的動作：自己按的，或由群組的合併決定帶出來的 */
  action: RowAction | undefined;
  actionFromGroup: boolean;
  event: EventChoice | null;
  /** 「只留一筆」的群組：true＝留下的那筆，false＝被標成不匯入；其他情況 null */
  kept: boolean | null;
  unitKey: string | null;
  blockers: Blocker[];
  /** 確認了而且沒有任何問題，會寫進①③ */
  writable: boolean;
  confirmStatus: ConfirmStatus;
}

export interface WritePlan {
  vendors: {
    create: SheetRow<VendorColumn>[];
    update: { vendorId: string; name: string; changes: Partial<SheetRow<VendorColumn>> }[];
  };
  events: { create: SheetRow<EventColumn>[] };
  records: { create: SheetRow<RecordColumn>[] };
  staging: {
    append: StagingCell[][];
    update: { stagingId: string; changes: Partial<Record<StagingColumn, StagingCell>> }[];
  };
}

export interface ImportReview {
  rows: Map<number, RowReview>;
  units: Map<string, VendorUnit>;
  plan: WritePlan;
}

// ---------- 小工具 ----------

function nextIdFactory(prefix: string, existing: string[]): () => string {
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0;
  for (const id of existing) {
    const match = pattern.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return () => {
    max += 1;
    return `${prefix}-${String(max).padStart(4, "0")}`;
  };
}

/** 有值的欄位越多越完整；一樣多就留前面那筆 */
export function completeness(row: WashedRow): number {
  const { interpretation: i } = row;
  return [
    row.vendorName,
    row.email.value,
    row.contactMethod,
    row.contactInfo,
    i.contactPerson,
    i.otherChannels,
    row.date.iso,
    i.cashNtd,
    i.item,
    i.quantity,
    row.owner,
    row.status.status,
  ].filter((value) => value !== null && value !== "").length;
}

export function mostCompleteRow(rows: WashedRow[]): WashedRow {
  return rows.reduce((best, row) => {
    const diff = completeness(row) - completeness(best);
    return diff > 0 || (diff === 0 && row.rowNumber < best.rowNumber) ? row : best;
  });
}

/** 頁首要對應的舊活動名稱，以及各有幾筆 */
export function eventLabelsOf(rows: WashedRow[]): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const label = row.eventLabel.trim();
    if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => ({ label, count }));
}

function methodValue(method: ContactMethod, info: string): string {
  return `${method}\u001f${info}`;
}

function methodLabel(method: ContactMethod, info: string): string {
  return method === "Email" || !info ? method : `${method}（${info}）`;
}

function parseMethodValue(value: string): { method: ContactMethod; info: string } {
  const [method, info = ""] = value.split("\u001f");
  return { method: method as ContactMethod, info };
}

interface FieldValue {
  value: string;
  label: string;
}

function rowFieldValue(row: WashedRow, field: VendorField): FieldValue | null {
  const text = (value: string | null): FieldValue | null =>
    value && value.trim() ? { value: value.trim(), label: value.trim() } : null;
  switch (field) {
    case "廠商名稱":
      return text(row.vendorName);
    case "主要聯絡方式":
      return row.contactMethod
        ? { value: methodValue(row.contactMethod, row.contactInfo), label: methodLabel(row.contactMethod, row.contactInfo) }
        : null;
    case "Email":
      return text(row.email.value);
    case "聯絡窗口":
      // 已換掉的舊窗口不能當成現在的窗口（寫進①的備註）
      return row.contactValidity === "replaced" ? null : text(row.interpretation.contactPerson);
    case "其他聯絡管道":
      return text(row.interpretation.otherChannels);
  }
}

function existingFieldValue(vendor: ExistingVendor, field: VendorField): FieldValue | null {
  const text = (value: string | null): FieldValue | null =>
    value && value.trim() ? { value: value.trim(), label: value.trim() } : null;
  switch (field) {
    case "廠商名稱":
      return text(vendor.name);
    case "主要聯絡方式":
      return vendor.contactMethod
        ? {
            value: methodValue(vendor.contactMethod, vendor.contactInfo),
            label: methodLabel(vendor.contactMethod, vendor.contactInfo),
          }
        : null;
    case "Email":
      return text(vendor.email);
    case "聯絡窗口":
      return text(vendor.contactPerson);
    case "其他聯絡管道":
      return text(vendor.otherChannels);
  }
}

function sameName(a: string, b: string): boolean {
  return vendorNameKey(a) === vendorNameKey(b);
}

// ---------- 主函式 ----------

/** 依目前的資料和公關長的選擇，算出每一列的狀態、每一家廠商要怎麼寫，以及完整的寫入計畫 */
export function reviewImport(rows: WashedRow[], choices: ImportChoices, context: ImportContext): ImportReview {
  const byNumber = new Map(rows.map((row) => [row.rowNumber, row]));
  const eventsById = new Map(context.events.map((event) => [event.id, event]));

  // 1. 對應活動
  function eventFor(row: WashedRow): EventChoice | null {
    const label = row.eventLabel.trim();
    const choice = choices.eventByRow[row.rowNumber] ?? (label ? choices.eventByLabel[label] : undefined);
    if (!choice) return null;
    if (choice.kind === "existing") return eventsById.has(choice.eventId) ? choice : null;
    const name = choice.name.trim() || label;
    return name ? { kind: "history", name } : null;
  }

  /** 同名的歷史活動已經在②，就沿用那一列 */
  function existingHistoryId(name: string): string | null {
    return (
      context.events.find((event) => event.status === HISTORY_EVENT_STATUS && sameName(event.name, name))?.id ?? null
    );
  }

  function eventKey(choice: EventChoice): string {
    if (choice.kind === "existing") return choice.eventId;
    return existingHistoryId(choice.name) ?? `history:${vendorNameKey(choice.name)}`;
  }

  // 2. 群組：合併決定 → 每一列的動作與所屬的廠商單位
  const groups = new Map<string, WashedRow[]>();
  for (const row of rows) {
    if (row.duplicateGroup) groups.set(row.duplicateGroup, [...(groups.get(row.duplicateGroup) ?? []), row]);
  }

  const action = new Map<number, RowAction | undefined>();
  const actionFromGroup = new Map<number, boolean>();
  const kept = new Map<number, boolean | null>();
  const unitOf = new Map<number, string>();

  for (const row of rows) {
    action.set(row.rowNumber, choices.actions[row.rowNumber]);
    actionFromGroup.set(row.rowNumber, false);
    kept.set(row.rowNumber, null);
    unitOf.set(row.rowNumber, `row:${row.rowNumber}`);
  }

  for (const [group, members] of groups) {
    const decision = choices.mergeDecisions[group];
    if (!decision) continue;
    let keptNumber: number | null = null;
    if (decision === "同一筆紀錄重複，只留一筆") {
      const chosen = choices.keepRow[group];
      keptNumber = members.some((row) => row.rowNumber === chosen) ? chosen! : mostCompleteRow(members).rowNumber;
    }
    for (const row of members) {
      const explicit = choices.actions[row.rowNumber];
      if (keptNumber !== null) kept.set(row.rowNumber, row.rowNumber === keptNumber);
      if (keptNumber !== null && row.rowNumber !== keptNumber) {
        // 被合併掉的那筆：只能不匯入或稍後處理
        action.set(row.rowNumber, explicit === "later" ? "later" : "skip");
        actionFromGroup.set(row.rowNumber, explicit !== "later");
        continue;
      }
      if (explicit === undefined) {
        action.set(row.rowNumber, "confirm");
        actionFromGroup.set(row.rowNumber, true);
      }
      if (decision !== "不同廠商，不合併") unitOf.set(row.rowNumber, `group:${group}`);
    }
  }

  // 3. 廠商單位：只看還要處理的列（確認或還沒處理），稍後處理和不匯入的不算
  const active = rows.filter((row) => {
    const value = action.get(row.rowNumber);
    return value === "confirm" || value === undefined;
  });
  const units = new Map<string, VendorUnit>();
  for (const row of active) {
    const key = unitOf.get(row.rowNumber)!;
    const unit = units.get(key) ?? { key, rowNumbers: [], candidates: [], match: null, conflicts: [] };
    unit.rowNumbers.push(row.rowNumber);
    units.set(key, unit);
  }

  for (const unit of units.values()) {
    const unitRows = unit.rowNumbers.map((n) => byNumber.get(n)!);
    unit.candidates = context.vendors.filter((vendor) =>
      unitRows.some((row) =>
        looksLikeSameVendor(
          { vendorName: row.vendorName, email: row.email.value },
          { vendorName: vendor.name, email: vendor.email },
        ),
      ),
    );
    const chosen = choices.vendorMatch[unit.key];
    if (unit.candidates.length === 0) unit.match = NEW_VENDOR;
    else if (chosen === NEW_VENDOR || unit.candidates.some((vendor) => vendor.id === chosen)) unit.match = chosen!;
    else unit.match = null;

    const existing = context.vendors.find((vendor) => vendor.id === unit.match) ?? null;
    for (const field of VENDOR_FIELDS) {
      const options = new Map<string, FieldOption>();
      const add = (value: FieldValue | null, from: string) => {
        if (!value) return;
        const option = options.get(value.value) ?? { ...value, from: [] };
        option.from.push(from);
        options.set(value.value, option);
      };
      if (existing) add(existingFieldValue(existing, field), `①既有（${existing.id}）`);
      for (const row of unitRows) add(rowFieldValue(row, field), `第 ${row.rowNumber} 列`);
      if (options.size < 2) continue;
      // 名稱只差空白、大小寫的不算不一致
      if (field === "廠商名稱" && new Set([...options.keys()].map(vendorNameKey)).size < 2) continue;
      const picked = choices.fieldChoices[unit.key]?.[field];
      unit.conflicts.push({ field, options: [...options.values()], chosen: picked && options.has(picked) ? picked : null });
    }
  }

  function resolved(unit: VendorUnit, field: VendorField): string | null {
    const conflict = unit.conflicts.find((item) => item.field === field);
    if (conflict) return conflict.chosen;
    const existing = context.vendors.find((vendor) => vendor.id === unit.match) ?? null;
    if (existing) {
      const value = existingFieldValue(existing, field);
      if (value) return value.value;
    }
    for (const n of unit.rowNumbers) {
      const value = rowFieldValue(byNumber.get(n)!, field);
      if (value) return value.value;
    }
    return null;
  }

  // 4. 每一列會擋住寫入的問題
  const blockers = new Map<number, Blocker[]>(rows.map((row) => [row.rowNumber, []]));
  const events = new Map<number, EventChoice | null>(rows.map((row) => [row.rowNumber, eventFor(row)]));

  for (const row of active) {
    const list = blockers.get(row.rowNumber)!;
    if (!row.vendorName) list.push({ kind: "廠商名稱", message: "缺廠商名稱" });

    const contact = checkContact(row);
    if (contact.block) {
      const kind: BlockerKind =
        row.contactMethod === "Email" ? "Email" : row.contactMethod ? "主要聯絡資訊" : "主要聯絡方式";
      list.push({ kind, message: contact.block });
    } else if (contact.review) {
      list.push({ kind: "主要聯絡方式", message: "主要聯絡方式待確認，請選一個" });
    }

    if (!events.get(row.rowNumber)) list.push({ kind: "對應活動", message: "還沒選對應活動" });

    if (row.duplicateGroup && !choices.mergeDecisions[row.duplicateGroup]) {
      list.push({ kind: "合併決定", message: `還沒選合併決定（${row.duplicateGroup}）` });
    }

    const unit = units.get(unitOf.get(row.rowNumber)!)!;
    if (unit.match === null) {
      const names = unit.candidates.map((vendor) => `「${vendor.name}」（${vendor.id}）`).join("、");
      list.push({ kind: "既有廠商", message: `還沒確認是不是①的${names}` });
    }
    const open = unit.conflicts.filter((conflict) => conflict.chosen === null).map((conflict) => conflict.field);
    if (open.length > 0) {
      list.push({ kind: "欄位不一致", message: `合併後欄位不一致，還沒選要用哪個值：${open.join("、")}` });
    } else if (unit.rowNumbers.length > 1 || (unit.match && unit.match !== NEW_VENDOR)) {
      // 合併後的廠商也要符合聯絡方式規則
      const method = resolved(unit, "主要聯絡方式");
      const parsed = method ? parseMethodValue(method) : null;
      const email = resolved(unit, "Email");
      if (parsed?.method === "Email" && !email) {
        list.push({ kind: "欄位不一致", message: "合併後主要聯絡方式是 Email，但沒有 Email" });
      }
    }
  }

  // 5. ③同一家廠商＋同一個活動只能一列
  const vendorKeyOf = (n: number) => {
    const unit = units.get(unitOf.get(n)!)!;
    return unit.match && unit.match !== NEW_VENDOR ? unit.match : `unit:${unit.key}`;
  };
  const seenRecord = new Map<string, number>();
  for (const row of active) {
    const event = events.get(row.rowNumber);
    if (!event) continue;
    const vendorKey = vendorKeyOf(row.rowNumber);
    const key = `${vendorKey}|${eventKey(event)}`;
    const list = blockers.get(row.rowNumber)!;
    const existingRecord = context.records.find(
      (record) => record.vendorId === vendorKey && record.eventId === eventKey(event),
    );
    if (existingRecord) {
      list.push({
        kind: "往來紀錄重複",
        message: `③已經有這家廠商在這個活動的往來紀錄（${existingRecord.id}），③同一組廠商＋活動只能一列`,
      });
      continue;
    }
    const first = seenRecord.get(key);
    if (first !== undefined) {
      list.push({
        kind: "往來紀錄重複",
        message: `跟第 ${first} 列是同一家廠商、同一個活動，③只能有一列；要合併請改選「同一筆紀錄重複，只留一筆」`,
      });
    } else {
      seenRecord.set(key, row.rowNumber);
    }
  }

  // 6. 每一列的結果
  const reviews = new Map<number, RowReview>();
  for (const row of rows) {
    const rowAction = action.get(row.rowNumber);
    const rowBlockers = blockers.get(row.rowNumber)!;
    const writable = rowAction === "confirm" && rowBlockers.length === 0;
    reviews.set(row.rowNumber, {
      rowNumber: row.rowNumber,
      action: rowAction,
      actionFromGroup: actionFromGroup.get(row.rowNumber)!,
      event: events.get(row.rowNumber) ?? null,
      kept: kept.get(row.rowNumber)!,
      unitKey: units.has(unitOf.get(row.rowNumber)!) ? unitOf.get(row.rowNumber)! : null,
      blockers: rowBlockers,
      writable,
      confirmStatus: writable ? "已寫入" : rowAction === "skip" ? "不匯入" : "待處理",
    });
  }

  return { rows: reviews, units, plan: buildPlan(rows, reviews, units, choices, context, resolved, existingHistoryId) };
}

function buildPlan(
  rows: WashedRow[],
  reviews: Map<number, RowReview>,
  units: Map<string, VendorUnit>,
  choices: ImportChoices,
  context: ImportContext,
  resolved: (unit: VendorUnit, field: VendorField) => string | null,
  existingHistoryId: (name: string) => string | null,
): WritePlan {
  const { createdAt, createdBy } = context.batch;
  const byNumber = new Map(rows.map((row) => [row.rowNumber, row]));
  const nextVendorId = nextIdFactory("V", context.vendors.map((vendor) => vendor.id));
  const nextEventId = nextIdFactory("E", context.events.map((event) => event.id));
  const nextRecordId = nextIdFactory("R", context.records.map((record) => record.id));
  const plan: WritePlan = {
    vendors: { create: [], update: [] },
    events: { create: [] },
    records: { create: [] },
    staging: { append: [], update: [] },
  };

  // 廠商
  const vendorIdOfUnit = new Map<string, string>();
  for (const unit of units.values()) {
    const writableRows = unit.rowNumbers
      .filter((n) => reviews.get(n)!.writable)
      .map((n) => byNumber.get(n)!);
    if (writableRows.length === 0) continue;

    const method = resolved(unit, "主要聯絡方式");
    const parsed = method ? parseMethodValue(method) : null;
    const stop = writableRows.some((row) => row.vendorStopContact);
    const oldContacts = writableRows
      .filter((row) => row.contactValidity === "replaced" && row.interpretation.contactPerson)
      .map((row) => `舊窗口：${row.interpretation.contactPerson}（舊資料，已更換）`);
    const notes = [...new Set([...oldContacts, ...(stop ? ["舊資料：廠商要求停止聯絡"] : [])])].join("；");
    const contactNotes = [...new Set(writableRows.map((row) => row.contactNote).filter(Boolean))].join("；");

    const existing = context.vendors.find((vendor) => vendor.id === unit.match) ?? null;
    if (existing) {
      vendorIdOfUnit.set(unit.key, existing.id);
      const changes: Partial<SheetRow<VendorColumn>> = {};
      const set = (column: VendorColumn, next: string | null, current: string | null) => {
        if (next !== null && next !== (current ?? "")) changes[column] = next;
      };
      set("廠商名稱", resolved(unit, "廠商名稱"), existing.name);
      if (parsed) {
        set("主要聯絡方式", parsed.method, existing.contactMethod);
        set("主要聯絡資訊", parsed.method === "Email" ? "" : parsed.info, existing.contactInfo);
      }
      set("Email", resolved(unit, "Email"), existing.email);
      set("聯絡窗口", resolved(unit, "聯絡窗口"), existing.contactPerson);
      set("其他聯絡管道", resolved(unit, "其他聯絡管道"), existing.otherChannels);
      if (contactNotes) changes["聯絡備註"] = contactNotes;
      // 停止聯絡只能從「否」改成「是」，不能反過來
      if (stop && !existing.stopContact) changes["廠商主動要求停止聯絡"] = "是";
      if (notes) changes["備註"] = notes;
      if (Object.keys(changes).length > 0) {
        changes["最後更新時間"] = createdAt;
        changes["最後更新人"] = createdBy;
        plan.vendors.update.push({ vendorId: existing.id, name: existing.name, changes });
      }
      continue;
    }

    const id = nextVendorId();
    vendorIdOfUnit.set(unit.key, id);
    plan.vendors.create.push({
      廠商ID: id,
      廠商名稱: resolved(unit, "廠商名稱") ?? "",
      產業類別: "",
      聯絡窗口: resolved(unit, "聯絡窗口") ?? "",
      窗口職稱: "",
      主要聯絡方式: parsed?.method ?? "",
      主要聯絡資訊: parsed && parsed.method !== "Email" ? parsed.info : "",
      Email: resolved(unit, "Email") ?? "",
      電話: "",
      其他聯絡管道: resolved(unit, "其他聯絡管道") ?? "",
      聯絡備註: contactNotes,
      廠商主動要求停止聯絡: stop ? "是" : "否",
      備註: notes,
      資料來源: SOURCE,
      最後更新時間: createdAt,
      最後更新人: createdBy,
    });
  }

  // 歷史活動與往來紀錄
  const historyIds = new Map<string, string>();
  function eventIdFor(choice: EventChoice): string {
    if (choice.kind === "existing") return choice.eventId;
    const existingId = existingHistoryId(choice.name);
    if (existingId) return existingId;
    const key = vendorNameKey(choice.name);
    const known = historyIds.get(key);
    if (known) return known;
    const id = nextEventId();
    historyIds.set(key, id);
    plan.events.create.push({
      活動ID: id,
      活動名稱: choice.name,
      活動日期: "",
      招商截止日: "",
      活動簡介: "",
      合作需求: "",
      企劃書版本: "",
      企劃書連結: "",
      活動狀態: HISTORY_EVENT_STATUS,
      資料來源: SOURCE,
      最後更新時間: createdAt,
      最後更新人: createdBy,
    });
    return id;
  }

  const eventIdOfRow = new Map<number, string>();
  for (const row of rows) {
    const review = reviews.get(row.rowNumber)!;
    if (!review.writable || !review.event || !review.unitKey) continue;
    const eventId = eventIdFor(review.event);
    eventIdOfRow.set(row.rowNumber, eventId);
    const { interpretation: i } = row;
    // 舊狀態不能直接採用的寫「待確認」；原狀態和舊聯絡日期寫進合作備註
    const status = row.status.adoptable && row.status.status ? row.status.status : "待確認";
    plan.records.create.push({
      往來ID: nextRecordId(),
      廠商ID: vendorIdOfUnit.get(review.unitKey)!,
      廠商名稱: "", // ③由公式帶出
      活動ID: eventId,
      活動名稱: "", // ③由公式帶出
      負責組員: row.owner,
      聯絡狀態: status,
      處理決策: row.status.decision,
      寄信次數: "", // ③由④自動計算
      最後寄信時間: "",
      合作備註: `舊資料：${row.date.iso ?? "日期不明"} 聯絡，原狀態：${row.statusRaw.trim() || "空白"}`,
      合作承諾: "",
      成果連結: "",
      待補資料: "",
      資料來源: SOURCE,
      最後更新時間: createdAt,
      最後更新人: createdBy,
      "現金金額（NTD）": i.cashNtd ?? "",
      實物品項: i.item ?? "",
      實物數量: i.quantity ?? "",
      單位: i.unit ?? "",
    });
  }

  // ⑤：每一列都留底；從⑤讀回來的待處理列改成更新那一列
  for (const row of rows) {
    const review = reviews.get(row.rowNumber)!;
    const mergeDecision: MergeDecision | null = row.duplicateGroup
      ? (choices.mergeDecisions[row.duplicateGroup] ?? null)
      : null;
    const archive = {
      mergeDecision,
      eventId: eventIdOfRow.get(row.rowNumber) ?? "",
      confirmStatus: review.confirmStatus,
    };
    if (row.stagingId) {
      plan.staging.update.push({
        stagingId: stagingIdFor(row, context.batch),
        changes: { 確認狀態: archive.confirmStatus, 對應活動ID: archive.eventId, 合併決定: mergeDecision ?? "" },
      });
    } else {
      plan.staging.append.push(toStagingRow(row, context.batch, archive));
    }
  }

  return plan;
}

// ---------- 畫面上的操作 ----------

/** 設定一列的動作；有問題的列不能確認（只能稍後處理或不匯入） */
export function setRowAction(
  review: ImportReview,
  choices: ImportChoices,
  rowNumber: number,
  next: RowAction | undefined,
): ImportChoices {
  const current = review.rows.get(rowNumber);
  if (!current) return choices;
  if (next === "confirm" && current.blockers.length > 0) return choices;
  const actions = { ...choices.actions };
  if (next === undefined) delete actions[rowNumber];
  else actions[rowNumber] = next;
  return { ...choices, actions };
}

/** 「確認所有沒有問題的列」：只動還沒處理、也不在疑似重複群組裡的列 */
export function confirmAllReady(review: ImportReview, choices: ImportChoices): ImportChoices {
  const actions = { ...choices.actions };
  for (const row of review.rows.values()) {
    if (row.action === undefined && row.blockers.length === 0) actions[row.rowNumber] = "confirm";
  }
  return { ...choices, actions };
}
