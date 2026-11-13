import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { washTable, type ColumnMapping, type RawTable, type WashedRow } from "../pipeline.ts";
import {
  applyAction,
  bulkAcceptTargets,
  canConfirm,
  countByDisposition,
  editDefaults,
  flaggedFields,
  orderForReview,
  recheckRow,
  reviewProgress,
  stagingRowsFor,
  type ReviewActions,
} from "../review.ts";
import { STAGING_COLUMNS } from "../staging.ts";

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

const context = {
  batchId: "IMP-TEST",
  sourceName: "golden.xlsx",
  createdAt: "2026-11-13T10:00:00+08:00",
  createdBy: "lead@example.com",
};

describe("預覽頁統計", () => {
  it("四種處置各幾筆：7／2／1／2", () => {
    assert.deepEqual(countByDisposition(rows), {
      可暫存: 2,
      "可暫存／禁止聯絡": 1,
      待人工覆核: 7,
      阻擋正式匯入: 2,
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

describe("阻擋正式匯入的列不能確認", () => {
  it("07、08 不能接受", () => {
    assert.equal(canConfirm(row("07")), false);
    assert.equal(canConfirm(row("08")), false);
    const actions = applyAction(rows, {}, row("07").rowNumber, "accepted");
    assert.equal(actions[row("07").rowNumber], undefined);
  });

  it("但可以選「不匯入」", () => {
    const actions = applyAction(rows, {}, row("08").rowNumber, "skipped");
    assert.equal(actions[row("08").rowNumber], "skipped");
  });

  it("整批接受只包含可暫存的列，不含阻擋和待人工覆核", () => {
    const targets = bulkAcceptTargets(rows, {});
    assert.deepEqual(
      targets.map((n) => rows.find((r) => r.rowNumber === n)?.legacyId),
      ["05", "09", "11"],
    );
  });

  it("已經處理過的列不會被整批接受覆蓋", () => {
    const actions: ReviewActions = { [row("05").rowNumber]: "skipped" };
    assert.ok(!bulkAcceptTargets(rows, actions).includes(row("05").rowNumber));
  });

  it("阻擋的列就算 actions 被改成接受，也不會進到⑤", () => {
    const forged: ReviewActions = { [row("07").rowNumber]: "accepted" };
    assert.equal(stagingRowsFor(rows, forged, context).length, 0);
  });
});

describe("編輯後重新檢查", () => {
  it("08 補上有效 Email 和日期後不再被阻擋", () => {
    const fixed = recheckRow(row("08"), {
      ...editDefaults(row("08")),
      email: "hello@lifestyle.example.com",
      contactDate: "2025-09-30",
    });
    assert.notEqual(fixed.disposition, "阻擋正式匯入");
    assert.equal(fixed.email.value, "hello@lifestyle.example.com");
    assert.equal(fixed.date.iso, "2025-09-30");
    assert.equal(canConfirm(fixed), true);
  });

  it("08 只補日期、Email 還是無效：仍然阻擋", () => {
    const stillBroken = recheckRow(row("08"), {
      ...editDefaults(row("08")),
      email: "lifestyle.example.com",
      contactDate: "2025-09-30",
    });
    assert.equal(stillBroken.disposition, "阻擋正式匯入");
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

describe("待確認欄位標示", () => {
  it("07 標出廠商名稱；08 標出 Email 和日期；06 標出窗口", () => {
    assert.ok(flaggedFields(row("07")).has("廠商名稱"));
    assert.ok(flaggedFields(row("08")).has("Email"));
    assert.ok(flaggedFields(row("08")).has("聯絡日期"));
    assert.ok(flaggedFields(row("06")).has("聯絡窗口"));
  });
  it("05 沒有需要特別看的欄位", () => {
    assert.equal(flaggedFields(row("05")).size, 0);
  });
});

describe("⑤舊資料暫存格式", () => {
  it("接受和編輯的列轉成 32 欄，不匯入的列不會出現", () => {
    let actions: ReviewActions = {};
    actions = applyAction(rows, actions, row("05").rowNumber, "accepted");
    actions = applyAction(rows, actions, row("11").rowNumber, "accepted");
    actions = applyAction(rows, actions, row("09").rowNumber, "skipped");
    const staging = stagingRowsFor(rows, actions, context);
    assert.equal(staging.length, 2);
    assert.ok(staging.every((cells) => cells.length === STAGING_COLUMNS.length));
    assert.equal(STAGING_COLUMNS.length, 32);
    const stopColumn = STAGING_COLUMNS.indexOf("廠商停止聯絡");
    const dispositionColumn = STAGING_COLUMNS.indexOf("匯入處置");
    assert.equal(staging[1][stopColumn], "是");
    assert.equal(staging[1][dispositionColumn], "可暫存／禁止聯絡");
  });

  it("進度統計", () => {
    const actions: ReviewActions = {
      [row("05").rowNumber]: "accepted",
      [row("08").rowNumber]: "skipped",
    };
    assert.deepEqual(reviewProgress(rows, actions), { pending: 10, confirmed: 1, skipped: 1 });
  });
});
