import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { washTable, type ColumnMapping, type RawTable, type WashedRow } from "../pipeline.ts";
import { countByDisposition, editDefaults, orderForReview, recheckRow } from "../review.ts";

const golden = JSON.parse(
  readFileSync(new URL("./golden.json", import.meta.url), "utf8"),
) as { raw: string[][] };
const [headers, ...dataRows] = golden.raw;
const table: RawTable = { headers, rows: dataRows };
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
const { rows } = washTable(table, mapping);

function row(legacyId: string): WashedRow {
  const found = rows.find((candidate) => candidate.legacyId === legacyId);
  assert.ok(found, `找不到舊序 ${legacyId}`);
  return found;
}

describe("預覽頁統計", () => {
  it("四種處置各幾筆：8／2／1／1", () => {
    assert.deepEqual(countByDisposition(rows), {
      可暫存: 2,
      "可暫存／禁止聯絡": 1,
      待人工覆核: 8,
      阻擋正式匯入: 1,
    });
  });
});

describe("疑似重複排在一起", () => {
  it("01/02、03/04 各成一組，其他單獨一列；總數不變（沒有合併）", () => {
    const sections = orderForReview(rows);
    const shape = sections.map((section) => section.rows.map((r) => r.legacyId));
    assert.deepEqual(shape, [
      ["01", "02"],
      ["03", "04"],
      ["05"],
      ["06"],
      ["07"],
      ["08"],
      ["09"],
      ["10"],
      ["11"],
      ["12"],
    ]);
    assert.equal(sections.flatMap((section) => section.rows).length, 12);
  });

  it("後面才出現的同組資料會被拉到第一筆旁邊", () => {
    const shuffled = [row("01"), row("05"), row("02")];
    assert.deepEqual(
      orderForReview(shuffled).map((section) => section.rows.map((r) => r.legacyId)),
      [["01", "02"], ["05"]],
    );
  });
});

describe("編輯後重新檢查", () => {
  it("08 選 Email、補上有效 Email 和日期後可以確認", () => {
    const fixed = recheckRow(row("08"), {
      ...editDefaults(row("08")),
      contactMethod: "Email",
      email: "hello@lifestyle.example.com",
      contactDate: "2025-09-30",
    });
    assert.notEqual(fixed.disposition, "阻擋正式匯入");
    assert.equal(fixed.email.value, "hello@lifestyle.example.com");
    assert.equal(fixed.date.iso, "2025-09-30");
    assert.equal(fixed.disposition, "待人工覆核", "舊狀態「已聯絡」還是要人看，但不再阻擋");
  });

  it("08 選 Email 但 Email 還是無效：阻擋", () => {
    const stillBroken = recheckRow(row("08"), {
      ...editDefaults(row("08")),
      contactMethod: "Email",
      email: "lifestyle.example.com",
      contactDate: "2025-09-30",
    });
    assert.equal(stillBroken.disposition, "阻擋正式匯入");
  });

  it("08 選官網表單、填網址 → 不阻擋；選了卻沒填資訊 → 阻擋", () => {
    const website = recheckRow(row("08"), {
      ...editDefaults(row("08")),
      contactMethod: "官網表單",
      contactInfo: "lifestyle.example.com",
    });
    assert.equal(website.contactMethod, "官網表單");
    assert.equal(website.contactInfo, "lifestyle.example.com");
    assert.notEqual(website.disposition, "阻擋正式匯入");
    assert.ok(!website.reviewReasons.includes("主要聯絡方式待確認"));

    const empty = recheckRow(row("08"), { ...editDefaults(row("08")), contactMethod: "LINE", contactInfo: " " });
    assert.equal(empty.disposition, "阻擋正式匯入");
    assert.ok(empty.reviewReasons.includes("主要聯絡方式是 LINE，主要聯絡資訊不能空白"));
  });

  it("選 Email 時不保留主要聯絡資訊；聯絡備註會留下", () => {
    const edited = recheckRow(row("05"), {
      ...editDefaults(row("05")),
      contactMethod: "Email",
      contactInfo: "不該留下",
      contactNote: "要跟上一屆要 LINE",
    });
    assert.equal(edited.contactInfo, "");
    assert.equal(edited.contactNote, "要跟上一屆要 LINE");
  });

  it("07 補上廠商名稱後可以確認，狀態依原文重算", () => {
    const fixed = recheckRow(row("07"), { ...editDefaults(row("07")), vendorName: "某某企業" });
    assert.equal(fixed.vendorName, "某某企業");
    assert.equal(fixed.disposition, "可暫存");
    assert.equal(fixed.status.adoptable, true);
  });

  it("11 編輯後停止聯絡標記不會消失", () => {
    const edited = recheckRow(row("11"), { ...editDefaults(row("11")), vendorName: "稻禾餐飲（本店）" });
    assert.equal(edited.vendorStopContact, true);
    assert.equal(edited.disposition, "可暫存／禁止聯絡");
  });

  it("疑似重複的列編輯後仍在原本的群組（不自動合併）", () => {
    const edited = recheckRow(row("02"), { ...editDefaults(row("02")), vendorName: "全家便利商店" });
    assert.equal(edited.duplicateGroup, row("02").duplicateGroup);
    assert.equal(edited.disposition, "待人工覆核");
  });

  it("原本的資料沒有被改到", () => {
    recheckRow(row("08"), { ...editDefaults(row("08")), email: "a@example.com" });
    assert.equal(row("08").email.value, null);
  });
});

