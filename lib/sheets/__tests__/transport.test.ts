import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSheetsTransport, SheetsError, type SheetCell } from "../transport.ts";
import { STAGING_COLUMNS } from "../../washing/staging.ts";

// 只有離線 placeholder；不使用真實 OAuth 憑證或真實試算表 ID。
const spreadsheetId = "offline-sheet";
const range = "'5. 舊資料暫存'!A1:AF";
const json = (value: unknown, status = 200) => Response.json(value, { status });

function client(fetcher: typeof fetch, getAccessToken = async () => "offline-placeholder") {
  return createSheetsTransport({ spreadsheetId, getAccessToken }, fetcher);
}

function isSheetsError(code: SheetsError["code"], outcome: SheetsError["writeOutcome"], status?: number) {
  return (error: unknown) => {
    assert.ok(error instanceof SheetsError);
    assert.equal(error.code, code);
    assert.equal(error.writeOutcome, outcome);
    assert.equal(error.status, status);
    return true;
  };
}

describe("Sheets HTTP 讀寫底層（完全離線）", () => {
  it("讀取時編碼分頁與範圍、不快取、不把憑證放進 URL", async () => {
    const sheets = client(async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, "https://sheets.googleapis.com");
      assert.equal(decodeURIComponent(url.pathname), `/v4/spreadsheets/${spreadsheetId}/values/${range}`);
      assert.equal(url.searchParams.get("majorDimension"), "ROWS");
      assert.equal(url.toString().includes("offline-placeholder"), false);
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer offline-placeholder");
      assert.equal(init?.cache, "no-store");
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal instanceof AbortSignal);
      assert.equal(init?.method, "GET");
      assert.equal(init?.body, undefined);
      return json({ range, values: [["甲", 0, false], [], ["乙"]] });
    });
    assert.deepEqual(await sheets.readValues(range), [["甲", 0, false], [], ["乙"]]);
  });

  it("空範圍省略 values 時回傳空陣列", async () => {
    assert.deepEqual(await client(async () => json({ range })).readValues(range), []);
  });

  it("32 欄原文使用 RAW 新增，保留公式樣式字串，並只回報結果摘要", async () => {
    const rows: SheetCell[][] = [STAGING_COLUMNS.map(() => "")];
    rows[0][7] = '=HYPERLINK("https://example.invalid", "舊資料")';
    const sheets = client(async (input, init) => {
      const url = new URL(String(input));
      assert.ok(url.pathname.endsWith(":append"));
      assert.equal(url.searchParams.get("valueInputOption"), "RAW");
      assert.equal(url.searchParams.get("insertDataOption"), "INSERT_ROWS");
      assert.equal(url.searchParams.get("includeValuesInResponse"), "false");
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), { range, majorDimension: "ROWS", values: rows });
      return json({ spreadsheetId, updates: { updatedRange: "'5. 舊資料暫存'!A3:AF3", updatedRows: 1 } });
    });
    assert.deepEqual(await sheets.appendRows(range, rows), {
      updatedRange: "'5. 舊資料暫存'!A3:AF3", updatedRows: 1,
    });
  });

  it("每次操作重新取得憑證，不沿用第一次的值", async () => {
    let count = 0;
    const sheets = client(async (_input, init) => {
      assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer offline-${count}`);
      return json({ range });
    }, async () => `offline-${++count}`);
    await sheets.readValues(range);
    await sheets.readValues(range);
    assert.equal(count, 2);
  });

  it("缺少授權或授權層拋錯時不發出 HTTP，也不外洩原始例外", async () => {
    const fetcher: typeof fetch = async () => assert.fail("不得呼叫 Google");
    for (const getToken of [async () => "", async () => { throw new Error("private detail"); }]) {
      await assert.rejects(client(fetcher, getToken).appendRows(range, [["甲"]]),
        isSheetsError("authorization", "not_attempted"));
    }
  });

  it("非法 ID、空範圍、空批次與非有限數字在發出請求前擋下", async () => {
    const fetcher: typeof fetch = async () => assert.fail("不得呼叫 Google");
    assert.throws(() => createSheetsTransport({ spreadsheetId: "../other", getAccessToken: async () => "" }, fetcher), SheetsError);
    const sheets = client(fetcher);
    await assert.rejects(sheets.readValues(" "), isSheetsError("invalid_input", "not_attempted"));
    for (const rows of [[], [[]], [[NaN]], [[Infinity]], [new Array<SheetCell>(1)], new Array<SheetCell[]>(1)]) {
      await assert.rejects(sheets.appendRows(range, rows), isSheetsError("invalid_input", "not_attempted"));
    }
  });

  it("401／403 只回報狀態，不把 Google 錯誤內容加入例外", async () => {
    for (const status of [401, 403]) {
      const sheets = client(async () => json({ error: "private detail" }, status));
      await assert.rejects(sheets.appendRows(range, [["甲"]]), (error: unknown) => {
        isSheetsError("authorization", "rejected", status)(error);
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes("private detail"), false);
        assert.equal(error.cause, undefined);
        return true;
      });
    }
  });

  it("寫入斷線、408、5xx 均標結果不明，且不重試", async () => {
    for (const status of [null, 408, 500, 503]) {
      let requests = 0;
      const sheets = client(async () => {
        requests++;
        if (status === null) throw new Error("private detail");
        return json({}, status);
      });
      await assert.rejects(sheets.appendRows(range, [["甲"]]),
        isSheetsError("request_failed", "unknown", status ?? undefined));
      assert.equal(requests, 1);
    }
  });

  it("429 配額不足直接回報，不自行重送", async () => {
    let requests = 0;
    const sheets = client(async () => { requests++; return json({}, 429); });
    await assert.rejects(sheets.appendRows(range, [["甲"]]), isSheetsError("request_failed", "rejected", 429));
    assert.equal(requests, 1);
  });

  it("成功回應缺結果、列數不符或試算表不符時不能宣稱寫入成功", async () => {
    for (const result of [{}, { spreadsheetId, updates: { updatedRange: range, updatedRows: 2 } },
      { spreadsheetId: "other-sheet", updates: { updatedRange: range, updatedRows: 1 } }]) {
      await assert.rejects(client(async () => json(result)).appendRows(range, [["甲"]]),
        isSheetsError("invalid_response", "unknown"));
    }
  });

  it("非 JSON 回應：讀取報格式錯誤，寫入報結果不明", async () => {
    const sheets = client(async () => new Response("not json"));
    await assert.rejects(sheets.readValues(range), isSheetsError("invalid_response", "not_attempted"));
    await assert.rejects(sheets.appendRows(range, [["甲"]]), isSheetsError("invalid_response", "unknown"));
  });

  it("不接受物件儲存格等不符合 Google ValueRange 的資料", async () => {
    for (const values of [null, [[{ text: "甲" }]]]) {
      await assert.rejects(client(async () => json({ range, values })).readValues(range),
        isSheetsError("invalid_response", "not_attempted"));
    }
  });

  it("等待憑證期間，呼叫端改動原陣列不影響送出的批次", async () => {
    const rows = [["甲"]];
    const sheets = client(async (_input, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)).values, [["甲"]]);
      return json({ spreadsheetId, updates: { updatedRange: range, updatedRows: 1 } });
    }, async () => { rows[0][0] = "乙"; return "offline-placeholder"; });
    await sheets.appendRows(range, rows);
  });
});
