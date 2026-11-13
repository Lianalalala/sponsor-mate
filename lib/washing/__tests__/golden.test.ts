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

  // 原本 7／2／1／2；D-024 後 08 不再因「沒有有效 Email」被阻擋，改成主要聯絡方式待確認
  it("分流結果 8／2／1／1（D-024：08 改為待人工覆核）", () => {
    const byDisposition = (label: string) =>
      result.rows.filter((row) => row.disposition === label).map((row) => row.legacyId);
    assert.deepEqual(byDisposition("待人工覆核"), ["01", "02", "03", "04", "06", "08", "10", "12"]);
    assert.deepEqual(byDisposition("可暫存"), ["05", "09"]);
    assert.deepEqual(byDisposition("可暫存／禁止聯絡"), ["11"]);
    assert.deepEqual(byDisposition("阻擋正式匯入"), ["07"]);
  });

  it("T-03、T-04 疑似重複只分組，不合併：12 筆都還在", () => {
    assert.equal(result.rows.length, 12);
    assert.equal(byLegacyId("01").duplicateGroup, byLegacyId("02").duplicateGroup);
    assert.equal(byLegacyId("03").duplicateGroup, byLegacyId("04").duplicateGroup);
    assert.notEqual(byLegacyId("01").duplicateGroup, byLegacyId("03").duplicateGroup);
    assert.equal(byLegacyId("02").vendorName, "全家");
  });

  it("T-11 缺廠商名稱：阻擋正式匯入", () => {
    const row = byLegacyId("07");
    assert.equal(row.disposition, "阻擋正式匯入");
    assert.ok(row.reviewReasons.some((reason) => reason.includes("缺廠商名稱")));
  });

  it("T-10 沒有 @ 的聯絡資料：不補 @、不當成 Email，也不直接丟掉；主要聯絡方式待確認", () => {
    const row = byLegacyId("08");
    assert.equal(row.email.value, null);
    assert.equal(row.email.check, "invalid_no_at");
    assert.equal(row.contactMethod, null);
    assert.equal(row.contactRaw, "lifestyle.example.com");
    assert.equal(row.disposition, "待人工覆核");
    assert.ok(row.reviewReasons.includes("主要聯絡方式待確認"));
  });

  it("有效 Email 的列，主要聯絡方式由程式直接選 Email", () => {
    for (const id of ["01", "03", "05", "11"]) assert.equal(byLegacyId(id).contactMethod, "Email");
  });

  it("T-13 停止聯絡是廠商層級，處置會標出來", () => {
    const row = byLegacyId("11");
    assert.equal(row.vendorStopContact, true);
    assert.equal(row.disposition, "可暫存／禁止聯絡");
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
