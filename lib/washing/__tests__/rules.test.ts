import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cleanDate } from "../date.ts";
import { findDuplicateGroups } from "../duplicates.ts";
import { cleanEmail } from "../email.ts";
import { EMPTY_INTERPRETATION, guardInterpretation } from "../interpretation.ts";
import { washTable } from "../pipeline.ts";
import { detectStopContact, interpretStatus } from "../status.ts";

describe("cleanDate", () => {
  const cases: [string, string | null, string][] = [
    ["2025/9/8", "2025-09-08", "valid"],
    ["２０２５／０９／０８", "2025-09-08", "valid"],
    ["114.9.15", "2025-09-15", "valid"],
    ["114年9月15日", "2025-09-15", "valid"],
    ["民國99年1月2日", "2010-01-02", "valid"],
    ["25/9/8", null, "ambiguous_year"],
    ["2025/2/30", null, "invalid"],
    ["999/1/1", null, "invalid"],
    ["13/45", null, "invalid"],
    ["9月8日", null, "missing_year"],
    ["—", null, "missing"],
    ["下週三", null, "unrecognized"],
  ];
  for (const [raw, iso, check] of cases) {
    it(raw, () => {
      const result = cleanDate(raw);
      assert.equal(result.iso, iso);
      assert.equal(result.check, check);
    });
  }
});

describe("cleanEmail", () => {
  it("全形 @ 視為格式差異", () => {
    assert.equal(cleanEmail("a＠example.com").value, "a@example.com");
  });
  it("同一格多個 Email 不自動選", () => {
    const result = cleanEmail("a@example.com / b@example.com");
    assert.equal(result.value, null);
    assert.equal(result.check, "multiple");
  });
  it("同一個 Email 出現兩次仍是一個", () => {
    assert.equal(cleanEmail("A@example.com；a@example.com").value, "a@example.com");
  });
  it("缺網域不算有效", () => {
    assert.equal(cleanEmail("abc@example").check, "invalid_format");
  });
  it("只有 LINE ID 視為沒有 Email", () => {
    assert.equal(cleanEmail("LINE：@demo_bakery").check, "missing");
  });
});

describe("interpretStatus", () => {
  it("沒看過的說法一律待釐清", () => {
    const result = interpretStatus("好像有興趣");
    assert.equal(result.status, null);
    assert.equal(result.adoptable, false);
  });
});

describe("detectStopContact", () => {
  it("抓得到常見說法", () => {
    for (const text of ["不要再聯絡", "請勿聯繫", "廠商要求停止聯絡", "別再寄信"]) {
      assert.equal(detectStopContact(text), true, text);
    }
  });
  it("不會誤抓其他的「勿」", () => {
    assert.equal(detectStopContact("需人工確認，勿自動合併"), false);
    assert.equal(detectStopContact("不得自動催信"), false);
  });
});

describe("findDuplicateGroups", () => {
  it("不同公司不會分到同一組", () => {
    const groups = findDuplicateGroups([
      { id: 1, vendorName: "甲公司", email: "a@example.com" },
      { id: 2, vendorName: "乙公司", email: "b@example.com" },
    ]);
    assert.equal(groups.size, 0);
  });
  it("缺名稱的列不參與比對", () => {
    const groups = findDuplicateGroups([
      { id: 1, vendorName: null, email: "a@example.com" },
      { id: 2, vendorName: "乙公司", email: "a@example.com" },
    ]);
    assert.equal(groups.size, 0);
  });
});

describe("guardInterpretation：AI 不能無中生有", () => {
  const contact = "窗口：測試窗口A；LINE：官方帳號";

  it("原文沒有的窗口要丟掉", () => {
    const { value, reviewReasons } = guardInterpretation(
      { ...EMPTY_INTERPRETATION, contactPerson: "王小明" },
      contact,
      "",
    );
    assert.equal(value.contactPerson, null);
    assert.equal(reviewReasons.length, 1);
  });

  it("原文有的窗口要留下", () => {
    const { value } = guardInterpretation(
      { ...EMPTY_INTERPRETATION, contactPerson: "測試窗口A" },
      contact,
      "",
    );
    assert.equal(value.contactPerson, "測試窗口A");
  });

  it("T-16 現金和物資都在原文才保留（金額有千分位）", () => {
    const { value } = guardInterpretation(
      { ...EMPTY_INTERPRETATION, cashNtd: 5000, item: "海報", quantity: 100, unit: "張" },
      "",
      "現金 $5,000 + 海報 100 張",
    );
    assert.equal(value.cashNtd, 5000);
    assert.equal(value.quantity, 100);
  });

  it("原文沒有的金額要丟掉", () => {
    const { value } = guardInterpretation(
      { ...EMPTY_INTERPRETATION, cashNtd: 9999 },
      "",
      "現金 3000",
    );
    assert.equal(value.cashNtd, null);
  });

  it("T-17 有問號的數量不能變成確定的數字", () => {
    const { value, reviewReasons } = guardInterpretation(
      { ...EMPTY_INTERPRETATION, item: "飲料", quantity: 50, unit: "杯" },
      "",
      "飲料 50 杯？",
    );
    assert.equal(value.quantity, null);
    assert.ok(reviewReasons.length > 0);
  });
});

describe("guardInterpretation：不確定的判斷", () => {
  it("只寫「待確定」、沒有數字時不算數量不確定", () => {
    const { reviewReasons } = guardInterpretation(EMPTY_INTERPRETATION, "", "待確定");
    assert.equal(reviewReasons.length, 0);
  });
  it("「合約 3000」的金額要保留", () => {
    const { value } = guardInterpretation(
      { ...EMPTY_INTERPRETATION, cashNtd: 3000 },
      "",
      "合約 3000",
    );
    assert.equal(value.cashNtd, 3000);
  });
  it("「約 3000」的金額不能當確定", () => {
    const { value } = guardInterpretation(
      { ...EMPTY_INTERPRETATION, cashNtd: 3000 },
      "",
      "約 3000",
    );
    assert.equal(value.cashNtd, null);
  });
});

describe("washTable", () => {
  const headers = ["廠商", "聯絡"];
  const mapping = { vendorName: [0], contact: [1] };

  it("空白列、完全相同的列會被排除，但留下紀錄", () => {
    const { rows, excluded } = washTable(
      {
        headers,
        rows: [
          ["甲", "a@example.com"],
          ["", "  "],
          ["甲 ", "a@example.com"],
        ],
      },
      mapping,
    );
    assert.equal(rows.length, 1);
    assert.deepEqual(excluded, [
      { rowNumber: 3, reason: "blank_row" },
      { rowNumber: 4, reason: "exact_duplicate", duplicateOf: 2 },
    ]);
  });

  it("欄位對應沒有廠商名稱時停下來", () => {
    assert.throws(() => washTable({ headers, rows: [] }, { contact: [1] }));
  });

  it("資料很少的社團：只有廠商名稱也能洗，但沒有 Email 會被阻擋", () => {
    const { rows } = washTable({ headers: ["店家"], rows: [["甲"], ["乙"]] }, { vendorName: [0] });
    assert.deepEqual(rows.map((row) => row.disposition), ["阻擋正式匯入", "阻擋正式匯入"]);
    assert.equal(rows[0].email.value, null);
    assert.equal(rows[0].date.iso, null);
    assert.equal(rows[0].legacyId, "");
  });

  it("同一欄不能對應到兩個欄位", () => {
    assert.throws(() =>
      washTable({ headers, rows: [] }, { vendorName: [0], contact: [0] }),
    );
  });

  it("AI 捨棄的內容不影響處置，但留下紀錄", () => {
    const interpretations = new Map([
      [2, { ...EMPTY_INTERPRETATION, contactPerson: "憑空的人" }],
    ]);
    const { rows } = washTable(
      { headers: ["廠商", "聯絡", "狀態"], rows: [["甲", "a@example.com", "拒絕"]] },
      { vendorName: [0], contact: [1], status: [2] },
      interpretations,
    );
    assert.equal(rows[0].disposition, "可暫存");
    assert.ok(rows[0].dataNotes.some((note) => note.includes("已捨棄")));
  });
});
