// 疑似重複分三種（D-023）：程式只分組、列證據、給建議，一律不自動合併。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { MERGE_DECISIONS } from "../duplicates.ts";
import { EMPTY_INTERPRETATION, type RowInterpretation } from "../interpretation.ts";
import { refreshDuplicates, washTable, type ColumnMapping, type RawTable, type WashedRow } from "../pipeline.ts";
import { applyMergeDecision, recheckRow, stagingRowsFor, type ReviewActions } from "../review.ts";
import { STAGING_COLUMNS } from "../staging.ts";

const headers = ["廠商", "聯絡", "日期", "狀態", "活動"];
const mapping: ColumnMapping = {
  vendorName: [0],
  contact: [1],
  contactDate: [2],
  status: [3],
  eventLabel: [4],
};

function wash(rows: string[][], interpretations = new Map<number, RowInterpretation>()): WashedRow[] {
  return washTable({ headers, rows }, mapping, interpretations).rows;
}

const context = {
  batchId: "IMP-TEST",
  sourceName: "test.xlsx",
  createdAt: "2026-11-13 10:00",
  createdBy: "pr-lead@example.com",
};
const cell = (staging: (string | number)[], column: (typeof STAGING_COLUMNS)[number]) =>
  staging[STAGING_COLUMNS.indexOf(column)];

describe("情況 ①：同一廠商、不同活動", () => {
  const rows = wash([
    ["全家", "family@example.com", "2026/09/10", "已寄", "2026九月系迎新"],
    ["全家", "family@example.com", "2024/12/01", "已合作", "2024耶誕舞會"],
  ]);

  it("分在同一組，建議「同一廠商，往來紀錄都保留」，屬於廠商層級", () => {
    assert.equal(rows[0].duplicateGroup, rows[1].duplicateGroup);
    const analysis = rows[0].duplicate;
    assert.ok(analysis);
    assert.equal(analysis.level, "廠商層級");
    assert.equal(analysis.suggestion, "同一廠商，往來紀錄都保留");
    assert.deepEqual(analysis.evidence.slice(0, 3), [
      "名稱相同（全家）",
      "Email 相同（family@example.com）",
      "活動不同（2026九月系迎新／2024耶誕舞會）",
    ]);
  });

  it("只是建議：處置是待人工覆核，⑤的合併決定留空", () => {
    for (const row of rows) assert.equal(row.disposition, "待人工覆核");
    const actions: ReviewActions = { [rows[0].rowNumber]: "accepted", [rows[1].rowNumber]: "accepted" };
    for (const staging of stagingRowsFor(rows, actions, context)) {
      assert.equal(cell(staging, "合併決定"), "");
      assert.match(String(cell(staging, "待確認原因")), /建議「同一廠商，往來紀錄都保留」/);
    }
  });

  it("兩年的窗口不同 → 標出不一致的欄位，每筆保留自己的值", () => {
    const interpretations = new Map<number, RowInterpretation>([
      [2, { ...EMPTY_INTERPRETATION, contactPerson: "王小姐" }],
      [3, { ...EMPTY_INTERPRETATION, contactPerson: "陳先生" }],
    ]);
    const withPeople = wash(
      [
        ["全家", "窗口：王小姐；family@example.com", "2026/09/10", "已寄", "2026九月系迎新"],
        ["全家", "窗口：陳先生；family@example.com", "2024/12/01", "已合作", "2024耶誕舞會"],
      ],
      interpretations,
    );
    assert.deepEqual(withPeople[0].duplicate?.mismatchedFields, ["聯絡窗口"]);
    assert.equal(withPeople[0].interpretation.contactPerson, "王小姐");
    assert.equal(withPeople[1].interpretation.contactPerson, "陳先生");
    assert.ok(withPeople[0].reviewReasons.includes("同組欄位不一致：聯絡窗口"));
    assert.match(withPeople[1].raw["聯絡"], /陳先生/);
  });
});

describe("情況 ②：同一廠商、同一活動出現兩次", () => {
  const rows = wash([
    ["青丘烘焙", "hello@example.com", "2025-09-08", "願意談", "迎新晚會"],
    ["青丘烘焙　", "hello@example.com", "9/8", "已談過", "迎新晚會"],
  ]);

  it("建議「同一筆紀錄重複，只留一筆」，屬於往來紀錄層級", () => {
    const analysis = rows[0].duplicate;
    assert.ok(analysis);
    assert.equal(analysis.level, "往來紀錄層級");
    assert.equal(analysis.suggestion, "同一筆紀錄重複，只留一筆");
    assert.equal(rows[1].duplicate, analysis);
  });
});

describe("情況 ③：名稱相似但可能是不同廠商", () => {
  const rows = wash([
    ["全家便利商店", "family-a@example.com", "2025/09/15", "已寄", "系迎新"],
    ["全家某分店", "family-b@example.com", "2025/09/15", "已寄", "系迎新"],
    ["全家", "family-c@example.com", "2025/09/15", "已寄", "系迎新"],
  ]);

  it("名稱不完全相同 → 不給建議、合併決定留空，只列證據", () => {
    const analysis = rows[0].duplicate;
    assert.ok(analysis);
    assert.equal(analysis.suggestion, null);
    assert.equal(analysis.level, "待公關長判斷");
    assert.equal(analysis.evidence[0], "名稱不完全相同（全家便利商店／全家某分店／全家）");
    assert.deepEqual(analysis.mismatchedFields, []);
  });
});

describe("同名但有些活動相同、有些不同", () => {
  it("不給建議，由公關長決定", () => {
    const rows = wash([
      ["全家", "family@example.com", "2025/09/15", "已寄", "系迎新"],
      ["全家", "family@example.com", "2025/09/16", "沒回", "系迎新"],
      ["全家", "family@example.com", "2024/12/01", "已合作", "耶誕舞會"],
    ]);
    assert.equal(rows[0].duplicate?.suggestion, null);
    assert.ok(rows[0].duplicate?.evidence.includes("有些筆活動相同、有些不同，請公關長決定"));
  });
});

describe("Golden Dataset 疑似重複", () => {
  const golden = JSON.parse(
    readFileSync(new URL("./golden.json", import.meta.url), "utf8"),
  ) as { raw: string[][] };
  const [goldenHeaders, ...goldenRows] = golden.raw;
  const table: RawTable = { headers: goldenHeaders, rows: goldenRows };
  const goldenMapping: ColumnMapping = {
    legacyId: [0],
    vendorName: [1],
    contact: [2],
    contactDate: [3],
    status: [4],
    sponsorship: [5],
    eventLabel: [6],
    owner: [7],
    notes: [8],
  };
  const { rows } = washTable(table, goldenMapping);
  const byId = (id: string) => rows.find((row) => row.legacyId === id)!;

  it("03／04 青丘烘焙 → 情況 ②", () => {
    assert.equal(byId("03").duplicate?.suggestion, "同一筆紀錄重複，只留一筆");
    assert.equal(byId("04").duplicate?.suggestion, "同一筆紀錄重複，只留一筆");
  });

  it("01／02 全家便利商店／全家 → 不給建議、待人工覆核、不自動合併", () => {
    for (const id of ["01", "02"]) {
      const row = byId(id);
      assert.equal(row.disposition, "待人工覆核");
      assert.equal(row.duplicate?.suggestion, null);
      assert.deepEqual(row.duplicate?.evidence.slice(0, 3), [
        "名稱不完全相同（全家便利商店／全家）",
        "Email 相同（family-team@example.com）",
        "活動相同（系迎新）",
      ]);
    }
    const actions: ReviewActions = { [byId("01").rowNumber]: "accepted", [byId("02").rowNumber]: "accepted" };
    const staging = stagingRowsFor(rows, actions, context);
    assert.equal(staging.length, 2, "兩筆都還在，沒有被合併掉");
    for (const line of staging) assert.equal(cell(line, "合併決定"), "");
  });

  it("公關長選了合併決定 → 寫進同組每一筆的「合併決定」", () => {
    const group = byId("01").duplicateGroup!;
    const decisions = applyMergeDecision(rows, {}, group, "不同廠商，不合併");
    const actions: ReviewActions = { [byId("01").rowNumber]: "accepted", [byId("05").rowNumber]: "accepted" };
    const [first, single] = stagingRowsFor(rows, actions, context, decisions);
    assert.equal(cell(first, "合併決定"), "不同廠商，不合併");
    assert.equal(cell(single, "合併決定"), "", "不是疑似重複的列不填");
  });

  it("合併決定只接受三個選項和清除；不認得的群組不會被加進去", () => {
    const group = byId("03").duplicateGroup!;
    const chosen = applyMergeDecision(rows, {}, group, MERGE_DECISIONS[1]);
    assert.equal(chosen[group], "同一筆紀錄重複，只留一筆");
    assert.deepEqual(applyMergeDecision(rows, chosen, group, undefined), {});
    assert.deepEqual(applyMergeDecision(rows, {}, "DUP-99", MERGE_DECISIONS[0]), {});
    // @ts-expect-error 測試瀏覽器送來不在選單裡的值
    assert.deepEqual(applyMergeDecision(rows, {}, group, "自動合併"), {});
  });

  it("把 02 改名成「全家便利商店」後重新分析 → 同組變成名稱相同，建議情況 ②", () => {
    const edited = recheckRow(byId("02"), { vendorName: "全家便利商店", email: "family-team@example.com", contactDate: "2025-09-15" });
    const refreshed = refreshDuplicates(rows.map((row) => (row.rowNumber === edited.rowNumber ? edited : row)));
    const first = refreshed.find((row) => row.legacyId === "01")!;
    assert.equal(first.duplicate?.suggestion, "同一筆紀錄重複，只留一筆");
    assert.equal(first.disposition, "待人工覆核", "有建議也不會自動合併");
  });
});
