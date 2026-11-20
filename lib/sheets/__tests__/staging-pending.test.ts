import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { STAGING_COLUMNS } from "../../washing/staging.ts";
import { readPendingStagingRows } from "../staging-pending.ts";
import { StagingColumnCountError, type StagingReadClient } from "../staging-read.ts";
import { createSheetsTransport, SheetsError, type SheetCell } from "../transport.ts";

const notes = STAGING_COLUMNS.map((column) => `說明：${column}`);
const statusIndex = STAGING_COLUMNS.indexOf("確認狀態");
const fromRows = (rows: SheetCell[][]): StagingReadClient => ({
  readValues: async () => [[...STAGING_COLUMNS], notes, ...rows],
});

function row(status: SheetCell, id: string): SheetCell[] {
  const values: SheetCell[] = STAGING_COLUMNS.map(() => "");
  values[STAGING_COLUMNS.indexOf("暫存ID")] = id;
  values[statusIndex] = status;
  return values;
}

describe("⑤待處理資料讀回（完全離線）", () => {
  it("只用一次 GET，從混合狀態及空列中選出待處理資料，保留實際列號", async () => {
    const first = row("待處理", "offline-pending-1");
    const last = row("待處理", "offline-pending-2");
    let requests = 0;
    const client = createSheetsTransport({
      spreadsheetId: "offline-sheet",
      getAccessToken: async () => "offline-placeholder",
    }, async (input, init) => {
      requests++;
      assert.equal(decodeURIComponent(new URL(String(input)).pathname),
        "/v4/spreadsheets/offline-sheet/values/'5. 舊資料暫存'");
      assert.equal(init?.method, "GET");
      assert.equal(init?.body, undefined);
      return Response.json({
        range: "'5. 舊資料暫存'!A1:AI7",
        values: [STAGING_COLUMNS, notes, first, row("已寫入", "offline-done"), [],
          row("不匯入", "offline-skipped"), last],
      });
    });

    assert.deepEqual(await readPendingStagingRows(client), [
      { rowNumber: 3, values: first },
      { rowNumber: 7, values: last },
    ]);
    assert.equal(requests, 1);
  });

  it("沒有待處理資料時回傳空清單，不將空白、不明狀態或非文字值當作待處理", async () => {
    const others = ["已寫入", "不匯入", "", "未知狀態", " 待處理 ", true, 0];
    for (const rows of [[], [...others.map((status) => row(status, "offline-other")), [], ["offline-short"]]]) {
      assert.deepEqual(await readPendingStagingRows(fromRows(rows)), []);
    }
  });

  it("只看確認狀態欄，不受其他欄位出現待處理文字影響", async () => {
    const decoyId = row("已寫入", "待處理");
    const decoyDisposition = row("不匯入", "offline-decoy");
    decoyDisposition[STAGING_COLUMNS.indexOf("匯入處置")] = "待處理";
    const pending = row("待處理", "offline-selected");
    assert.deepEqual(await readPendingStagingRows(fromRows([decoyId, decoyDisposition, pending])), [
      { rowNumber: 5, values: pending },
    ]);
  });

  it("先核對標題，不把舊版 32 欄表誤判為沒有待處理資料", async () => {
    const client: StagingReadClient = { readValues: async () => [STAGING_COLUMNS.slice(0, 32), notes] };
    await assert.rejects(readPendingStagingRows(client), (error: unknown) => {
      assert.ok(error instanceof SheetsError);
      assert.equal(error.code, "schema_mismatch");
      return true;
    });
  });

  it("沿用整表欄數檢查，保留異常列號與欄數，避免回傳部分資料", async () => {
    const oversized = [...row("已寫入", "offline-oversized"), "離線測試多出欄位"];
    await assert.rejects(readPendingStagingRows(fromRows([row("待處理", "offline-pending"), oversized])),
      (error: unknown) => {
        assert.ok(error instanceof StagingColumnCountError);
        assert.equal(error.rowNumber, 4);
        assert.equal(error.expectedColumns, 35);
        assert.equal(error.actualColumns, 36);
        return true;
      });
  });

  it("HTTP 讀取失敗會保留原錯誤，不回傳空清單或自行重試", async () => {
    const expected = new SheetsError("request_failed", "not_attempted", 503);
    let requests = 0;
    const client: StagingReadClient = {
      readValues: async () => { requests++; throw expected; },
    };
    await assert.rejects(readPendingStagingRows(client), (error: unknown) => error === expected);
    assert.equal(requests, 1);
  });

  it("保留暫存ID、原始列號、停止聯絡及原始資料，後續編輯不改動讀取回應", async () => {
    const pending = row("待處理", "offline-original-id");
    pending[STAGING_COLUMNS.indexOf("原始列號")] = 17;
    pending[STAGING_COLUMNS.indexOf("廠商停止聯絡")] = "是";
    pending[STAGING_COLUMNS.indexOf("原始資料")] = JSON.stringify({ 欄位: "離線原文" });
    const snapshot = [...pending];
    Object.freeze(pending);
    const selected = await readPendingStagingRows(fromRows([pending]));
    assert.equal(selected[0].rowNumber, 3);
    assert.deepEqual(selected[0].values, snapshot);
    selected[0].values[0] = "已編輯";
    assert.deepEqual(pending, snapshot);
  });
});
