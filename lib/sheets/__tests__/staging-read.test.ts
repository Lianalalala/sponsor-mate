import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { STAGING_COLUMNS } from "../../washing/staging.ts";
import { readStagingRows, StagingColumnCountError, type StagingReadClient } from "../staging-read.ts";
import { createSheetsTransport, SheetsError, type SheetCell } from "../transport.ts";

const notes = STAGING_COLUMNS.map((column) => `說明：${column}`);
const fromTable = (table: SheetCell[][]): StagingReadClient => ({ readValues: async () => table });

function isSchemaMismatch(error: unknown) {
  assert.ok(error instanceof SheetsError);
  assert.equal(error.code, "schema_mismatch");
  assert.equal(error.writeOutcome, "not_attempted");
  return true;
}

describe("⑤舊資料暫存的內部唯讀（完全離線）", () => {
  it("只用一次 GET 讀取固定⑤分頁，核對標題後排除標題列與說明列", async () => {
    let requests = 0;
    const client = createSheetsTransport({
      spreadsheetId: "offline-sheet",
      getAccessToken: async () => "offline-placeholder",
    }, async (input, init) => {
      requests++;
      const url = new URL(String(input));
      assert.equal(url.origin, "https://sheets.googleapis.com");
      assert.equal(decodeURIComponent(url.pathname),
        "/v4/spreadsheets/offline-sheet/values/'5. 舊資料暫存'");
      assert.equal(url.searchParams.get("majorDimension"), "ROWS");
      assert.equal(init?.method, "GET");
      assert.equal(init?.body, undefined);
      return Response.json({
        range: "'5. 舊資料暫存'!A1:AI3",
        values: [STAGING_COLUMNS, notes, ["offline-row-1", "offline-batch"]],
      });
    });

    assert.deepEqual(await readStagingRows(client), [
      { rowNumber: 3, values: ["offline-row-1", "offline-batch"] },
    ]);
    assert.equal(requests, 1);
  });

  it("保留中間空列、尾端省略的空白格及實際列號，不改變儲存格型別", async () => {
    const table: SheetCell[][] = [[...STAGING_COLUMNS], notes, ["甲", 0, false], [], ["乙"]];
    assert.deepEqual(await readStagingRows(fromTable(table)), [
      { rowNumber: 3, values: ["甲", 0, false] },
      { rowNumber: 4, values: [] },
      { rowNumber: 5, values: ["乙"] },
    ]);
  });

  it("標題正確而沒有資料列時回傳空清單", async () => {
    for (const table of [[[...STAGING_COLUMNS]], [[...STAGING_COLUMNS], notes]]) {
      assert.deepEqual(await readStagingRows(fromTable(table)), []);
    }
  });

  it("整張分頁空白時視為缺少標題，不當作有效的空資料表", async () => {
    await assert.rejects(readStagingRows(fromTable([])), isSchemaMismatch);
  });

  it("標題不符時不回傳資料，保留上一層 schema_mismatch 錯誤", async () => {
    const wrongOrder = [...STAGING_COLUMNS];
    [wrongOrder[0], wrongOrder[1]] = [wrongOrder[1], wrongOrder[0]];
    for (const headers of [STAGING_COLUMNS.slice(0, 32), wrongOrder, [...STAGING_COLUMNS, "多出的欄位"]]) {
      await assert.rejects(readStagingRows(fromTable([headers, notes, ["甲"]])), isSchemaMismatch);
    }
  });

  it("標題正確但資料超過 35 欄時阻擋，錯誤不包含原始儲存格內容", async () => {
    const privateDetail = "僅供離線測試的原始儲存格內容";
    const table: SheetCell[][] = [[...STAGING_COLUMNS], notes, [...STAGING_COLUMNS.map(() => ""), privateDetail]];
    await assert.rejects(readStagingRows(fromTable(table)), (error: unknown) => {
      isSchemaMismatch(error);
      assert.ok(error instanceof StagingColumnCountError);
      assert.equal(error.rowNumber, 3);
      assert.equal(error.expectedColumns, 35);
      assert.equal(error.actualColumns, 36);
      assert.equal(error.message, "⑤舊資料暫存第 3 列有 36 欄，預期 35 欄，請核對試算表。");
      assert.equal(error.message.includes(privateDetail), false);
      assert.equal(JSON.stringify(error).includes(privateDetail), false);
      return true;
    });
  });

  it("空列後發現多個超寬列時，回報第一個異常的實際列號及欄數", async () => {
    const table: SheetCell[][] = [
      [...STAGING_COLUMNS], notes, ["有效列"], [],
      Array.from({ length: 36 }, () => ""),
      Array.from({ length: 37 }, () => ""),
    ];
    await assert.rejects(readStagingRows(fromTable(table)), (error: unknown) => {
      assert.ok(error instanceof StagingColumnCountError);
      assert.equal(error.rowNumber, 5);
      assert.equal(error.expectedColumns, 35);
      assert.equal(error.actualColumns, 36);
      return true;
    });
  });

  it("凍結的回應可以讀取，回傳列是副本，後續編輯不改動原始回應", async () => {
    const table: SheetCell[][] = [[...STAGING_COLUMNS], [...notes], ["原始資料"]];
    table.forEach((row) => Object.freeze(row));
    Object.freeze(table);
    const rows = await readStagingRows(fromTable(table));
    assert.notEqual(rows[0].values, table[2]);
    rows[0].values[0] = "已編輯";
    assert.deepEqual(table[2], ["原始資料"]);
  });

  it("傳遞 HTTP 層的錯誤，不把讀取失敗當成空資料表，也不自行重試", async () => {
    const expected = new SheetsError("request_failed", "not_attempted", 503);
    let requests = 0;
    const client: StagingReadClient = {
      readValues: async () => { requests++; throw expected; },
    };
    await assert.rejects(readStagingRows(client), (error: unknown) => error === expected);
    assert.equal(requests, 1);
  });

  it("社團授權層失敗時不發出 HTTP，也不外洩授權層的原始例外", async () => {
    const client = createSheetsTransport({
      spreadsheetId: "offline-sheet",
      getAccessToken: async () => { throw new Error("僅供測試的原始授權例外"); },
    }, async () => assert.fail("不得呼叫 Google"));
    await assert.rejects(readStagingRows(client), (error: unknown) => {
      assert.ok(error instanceof SheetsError);
      assert.equal(error.code, "authorization");
      assert.equal(error.writeOutcome, "not_attempted");
      assert.equal(error.message.includes("原始授權例外"), false);
      return true;
    });
  });
});
