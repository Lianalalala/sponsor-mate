import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { washTable, type ColumnMapping, type RawTable, type WashedRow } from "../pipeline.ts";

interface Expected {
  舊序: string;
  列號: number;
  名稱: string | null;
  Email: string | null;
  Email檢核: string;
  日期: string | null;
  日期檢核: string;
  活動: string;
  狀態: string;
  可採用: boolean;
  決策: string;
  停止聯絡: boolean;
  重複: string | null;
  處置: string;
  負責人: string;
}

const golden = JSON.parse(
  readFileSync(new URL("./golden.json", import.meta.url), "utf8"),
) as { raw: string[][]; expected: Expected[] };

const [headers, ...rows] = golden.raw;
const table: RawTable = { headers, rows };
const mapping: ColumnMapping = {
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

const result = washTable(table, mapping);

function byLegacyId(id: string): WashedRow {
  const row = result.rows.find((candidate) => candidate.legacyId === id);
  assert.ok(row, `找不到舊序 ${id}`);
  return row;
}

describe("Golden Dataset 逐筆比對", () => {
  for (const expected of golden.expected) {
    it(`舊序 ${expected.舊序}`, () => {
      const row = byLegacyId(expected.舊序);
      assert.deepEqual(
        {
          舊序: row.legacyId,
          列號: row.rowNumber,
          名稱: row.vendorName,
          Email: row.email.value,
          Email檢核: row.email.check,
          日期: row.date.iso,
          日期檢核: row.date.check,
          活動: row.eventLabel,
          狀態: row.status.label,
          可採用: row.status.adoptable,
          決策: row.status.decision,
          停止聯絡: row.vendorStopContact,
          重複: row.duplicateGroup,
          處置: row.disposition,
          負責人: row.owner,
        },
        expected,
      );
    });
  }
});

describe("驗收規則", () => {
  it("T-01 逐筆可追溯：12 筆都在，原始資料沒被改動", () => {
    const before = JSON.stringify(table);
    washTable(table, mapping);
    assert.equal(JSON.stringify(table), before);
    assert.deepEqual(
      result.rows.map((row) => row.rowNumber),
      [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
    );
    assert.equal(result.excluded.length, 0);
  });

  it("T-02 去除全形空白，原文仍保留", () => {
    const row = byLegacyId("04");
    assert.equal(row.vendorName, "青丘烘焙");
    assert.equal(row.raw["公司／店家"], "青丘烘焙　");
  });

  it("T-05 LINE 不會被誤當 Email", () => {
    assert.equal(byLegacyId("03").email.value, "hello@example.com");
  });

  it("T-11 缺廠商名稱無法寫入", () => {
    assert.equal(byLegacyId("07").disposition, "無法寫入");
  });

  it("T-10 沒有可用 Email 仍可寫入，但留空並留下紀錄", () => {
    const row = byLegacyId("08");
    assert.equal(row.disposition, "可寫入");
    assert.equal(row.email.value, null);
    assert.ok(row.dataNotes.some((note) => note.includes("缺@")));
  });

  it("需要處理的只有疑似重複和缺廠商名稱", () => {
    const needsHuman = result.rows.filter((row) => row.reviewReasons.length > 0);
    assert.deepEqual(needsHuman.map((row) => row.legacyId), ["01", "02", "03", "04", "07"]);
  });

  it("T-12 活動層級的拒絕不會擴大成廠商層級", () => {
    assert.equal(byLegacyId("05").vendorStopContact, false);
  });

  it("T-14、T-15 舊資料一律不計入 Gmail 成功寄件", () => {
    assert.ok(result.rows.every((row) => row.countsAsGmailSent === false));
  });

  it("T-18 舊活動不自動對應現行活動", () => {
    assert.ok(result.rows.every((row) => row.officialEventId === null));
  });

  it("T-19 舊窗口不得當作可用資料", () => {
    assert.equal(byLegacyId("06").contactValidity, "replaced");
  });
});
