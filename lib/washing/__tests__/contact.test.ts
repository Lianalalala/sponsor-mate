// 主要聯絡方式（D-024）：Email 型、LINE 型、官網型、沒有聯絡資訊各一筆。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkContact, CONTACT_METHODS, resolveContactMethod } from "../contact.ts";
import { cleanEmail } from "../email.ts";
import { EMPTY_INTERPRETATION, type RowInterpretation } from "../interpretation.ts";
import { washTable, type ColumnMapping } from "../pipeline.ts";
import { toStagingRow, STAGING_COLUMNS } from "../staging.ts";

const headers = ["廠商", "聯絡", "狀態", "活動"];
const mapping: ColumnMapping = { vendorName: [0], contact: [1], status: [2], eventLabel: [3] };

// 列號從 2 開始：Email 型、LINE 型、官網型、沒有聯絡資訊
const table = {
  headers,
  rows: [
    ["甲咖啡", "窗口：林小姐；cafe@example.com；LINE：@cafe_a", "未聯絡", "系迎新"],
    ["乙書店", "line id: 11joei32o", "未聯絡", "系迎新"],
    ["丙工作室", "lifestyle.example.com", "未聯絡", "系迎新"],
    ["丁餐廳", "", "未聯絡", "系迎新"],
  ],
};

// AI 的判斷；甲有有效 Email，AI 就算說 LINE 也不採用
const ai = new Map<number, RowInterpretation>([
  [2, { ...EMPTY_INTERPRETATION, contactMethod: "LINE", contactInfo: "@cafe_a", contactPerson: "林小姐" }],
  [3, { ...EMPTY_INTERPRETATION, contactMethod: "LINE", contactInfo: "11joei32o" }],
  [4, { ...EMPTY_INTERPRETATION, contactMethod: "官網表單", contactInfo: "lifestyle.example.com" }],
]);

const { rows } = washTable(table, mapping, ai);
const byName = (name: string) => rows.find((row) => row.vendorName === name)!;

describe("四種聯絡資料", () => {
  it("Email 型：有效 Email 由程式直接選 Email，不看 AI", () => {
    const row = byName("甲咖啡");
    assert.equal(row.contactMethod, "Email");
    assert.equal(row.contactInfo, "");
    assert.equal(row.email.value, "cafe@example.com");
    assert.equal(row.disposition, "可暫存");
  });

  it("LINE 型：沒有 Email，用 AI 判斷的 LINE，主要聯絡資訊照抄原文", () => {
    const row = byName("乙書店");
    assert.equal(row.contactMethod, "LINE");
    assert.equal(row.contactInfo, "11joei32o");
    assert.equal(row.email.value, null);
    assert.equal(row.disposition, "可暫存");
  });

  it("官網型：沒有 @ 的網址不當成無效 Email 丟掉，判為官網表單", () => {
    const row = byName("丙工作室");
    assert.equal(row.contactMethod, "官網表單");
    assert.equal(row.contactInfo, "lifestyle.example.com");
    assert.notEqual(row.disposition, "阻擋正式匯入");
  });

  it("沒有任何聯絡資訊：阻擋正式匯入", () => {
    const row = byName("丁餐廳");
    assert.equal(row.contactMethod, null);
    assert.equal(row.disposition, "阻擋正式匯入");
    assert.ok(row.reviewReasons.includes("沒有任何聯絡資訊"));
  });

  it("⑤會多出主要聯絡方式、主要聯絡資訊、聯絡備註三欄", () => {
    const context = { batchId: "IMP-T", sourceName: "t.xlsx", createdAt: "2026-11-13", createdBy: "a@example.com" };
    const line = toStagingRow(byName("乙書店"), context);
    assert.equal(line[STAGING_COLUMNS.indexOf("主要聯絡方式")], "LINE");
    assert.equal(line[STAGING_COLUMNS.indexOf("主要聯絡資訊")], "11joei32o");
    assert.equal(line[STAGING_COLUMNS.indexOf("聯絡備註")], "");
  });
});

describe("AI 的判斷要通過防呆", () => {
  it("AI 沒把握（null）→ 主要聯絡方式待確認，不阻擋", () => {
    const result = washTable(
      { headers, rows: [["戊商行", "請找學長要聯絡方式", "未聯絡", "系迎新"]] },
      mapping,
    );
    const [row] = result.rows;
    assert.equal(row.contactMethod, null);
    assert.equal(row.disposition, "待人工覆核");
    assert.ok(row.reviewReasons.includes("主要聯絡方式待確認"));
  });

  it("AI 給的聯絡資訊在原文找不到 → 捨棄，變回待確認", () => {
    const result = washTable(
      { headers, rows: [["己商行", "LINE 問過了", "未聯絡", "系迎新"]] },
      mapping,
      new Map([[2, { ...EMPTY_INTERPRETATION, contactMethod: "LINE", contactInfo: "@made_up" }]]),
    );
    const [row] = result.rows;
    assert.equal(row.contactMethod, null);
    assert.ok(row.dataNotes.includes("AI 的主要聯絡資訊在原文找不到，已捨棄"));
  });

  it("AI 說是 Email 不算數：Email 只由程式判斷", () => {
    const result = washTable(
      { headers, rows: [["庚商行", "geng.example.com", "未聯絡", "系迎新"]] },
      mapping,
      // AI 回傳了不該回傳的選項（Email 只能由程式判斷）
      new Map([[2, { ...EMPTY_INTERPRETATION, contactMethod: "Email", contactInfo: "geng.example.com" }]]),
    );
    assert.equal(result.rows[0].contactMethod, null);
  });

  it("主要聯絡方式不是 Email、但 Email 格式壞掉 → 不阻擋，但留下要補 Email 的紀錄", () => {
    const result = washTable(
      { headers, rows: [["辛商行", "LINE：@xin；信箱：xin@", "未聯絡", "系迎新"]] },
      mapping,
      new Map([[2, { ...EMPTY_INTERPRETATION, contactMethod: "LINE", contactInfo: "@xin" }]]),
    );
    const [row] = result.rows;
    assert.equal(row.contactMethod, "LINE");
    assert.notEqual(row.disposition, "阻擋正式匯入");
    assert.ok(row.dataNotes.some((note) => note.includes("要寄信前得先補好 Email")));
  });
});

describe("規則本身", () => {
  it("下拉選單選項", () => {
    assert.deepEqual([...CONTACT_METHODS], ["Email", "LINE", "Messenger", "IG", "官網表單", "電話", "其他"]);
  });

  it("有效 Email 永遠優先", () => {
    assert.deepEqual(resolveContactMethod(cleanEmail("a@example.com"), "LINE", "@a"), { method: "Email", info: "" });
  });

  it("只有橫線也算沒有聯絡資訊", () => {
    const facts = { contactRaw: "—", email: cleanEmail("—"), contactMethod: null, contactInfo: "" };
    assert.equal(checkContact(facts).block, "沒有任何聯絡資訊");
  });
});
