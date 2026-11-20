import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { VENDOR_COLUMNS, EVENT_COLUMNS, RECORD_COLUMNS } from "../../washing/write-plan.ts";
import { CONTACT_METHODS } from "../../washing/contact.ts";
import { MERGE_DECISIONS } from "../../washing/duplicates.ts";
import { CONFIRM_STATUSES, STAGING_COLUMNS } from "../../washing/staging.ts";
import { createClubSpreadsheet, SpreadsheetCreationError } from "../create-spreadsheet.ts";
import { MAIL_COLUMNS, SHEET_DEFINITIONS, SHEET_NAMES } from "../schema.ts";
import { assertStagingHeaders } from "../staging-schema.ts";
import { readStagingRows } from "../staging-read.ts";

// 僅為離線 placeholder，不使用真實 OAuth 憑證或任何真實試算表 ID。
const TOKEN = "offline-placeholder";
const ID = "offline-new-sheet";
const CLUB = "虛構示範社團";
const createdResponse = () => ({ spreadsheetId: ID,
  sheets: SHEET_DEFINITIONS.map((sheet) => ({ properties: { sheetId: sheet.sheetId, title: sheet.title } })),
});

interface Cell { userEnteredValue: { stringValue: string } }
interface UpdateCells {
  start: { sheetId: number; rowIndex: number; columnIndex: number };
  rows: { values: Cell[] }[];
  fields: string;
}
interface Validation {
  range: { sheetId: number; startRowIndex: number; endRowIndex?: number; startColumnIndex: number; endColumnIndex: number };
  rule: { condition: { type: string; values: { userEnteredValue: string }[] }; strict: boolean; showCustomUi: boolean };
}
interface BatchBody { requests: ({ updateCells?: UpdateCells; setDataValidation?: Validation })[]; includeSpreadsheetInResponse: boolean }

function initializedResponse(body: BatchBody) {
  return { spreadsheetId: ID, replies: body.requests.map(() => ({})) };
}

function expectError(
  code: SpreadsheetCreationError["code"],
  outcome: SpreadsheetCreationError["writeOutcome"],
  stage: SpreadsheetCreationError["stage"],
  id?: string,
  status?: number,
) {
  return (error: unknown) => {
    assert.ok(error instanceof SpreadsheetCreationError);
    assert.equal(error.code, code);
    assert.equal(error.writeOutcome, outcome);
    assert.equal(error.stage, stage);
    assert.equal(error.spreadsheetId, id);
    assert.equal(error.status, status);
    assert.equal(error.cause, undefined);
    return true;
  };
}

describe("建立社團資料庫試算表（完全離線）", () => {
  it("使用呼叫端憑證建立正式名稱的五頁；僅在標題、說明與下拉設定完成後回傳 ID", async () => {
    let calls = 0;
    const result = await createClubSpreadsheet(TOKEN, ` ${CLUB} `, async (input, init) => {
      const url = new URL(String(input));
      calls++;
      assert.equal(url.origin, "https://sheets.googleapis.com");
      assert.equal(url.href.includes(TOKEN), false);
      assert.equal(init?.method, "POST");
      assert.equal(init?.cache, "no-store");
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal instanceof AbortSignal);
      assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${TOKEN}`);
      assert.equal(new Headers(init?.headers).get("Content-Type"), "application/json");
      const rawBody = String(init?.body);
      assert.equal(rawBody.includes(TOKEN), false);
      assert.equal(rawBody.includes("formulaValue"), false);
      if (calls === 1) {
        assert.equal(url.pathname, "/v4/spreadsheets");
        assert.equal(url.searchParams.get("fields"), "spreadsheetId,sheets.properties(sheetId,title)");
        const body = JSON.parse(rawBody);
        assert.deepEqual(body.properties, { title: `${CLUB}｜sponsor-mate 資料庫`, locale: "zh_TW", timeZone: "Asia/Taipei" });
        assert.deepEqual(body.sheets.map((sheet: { properties: { title: string } }) => sheet.properties.title), [
          "1. 廠商", "2. 活動", "3. 往來紀錄", "4. 信件紀錄", "5. 舊資料暫存",
        ]);
        assert.deepEqual(body.sheets.map((sheet: { properties: { gridProperties: { columnCount: number } } }) =>
          sheet.properties.gridProperties.columnCount), [16, 12, 21, 25, 35]);
        for (const [index, sheet] of body.sheets.entries()) {
          assert.equal(sheet.properties.sheetId, index);
          assert.equal(sheet.properties.index, index);
          assert.equal(sheet.properties.gridProperties.rowCount, 1000);
          assert.equal(sheet.properties.gridProperties.frozenRowCount, 2);
        }
        return Response.json(createdResponse());
      }
      assert.equal(calls, 2, "不發出額外建表或重試請求");
      assert.equal(url.pathname, `/v4/spreadsheets/${ID}:batchUpdate`);
      const body: BatchBody = JSON.parse(rawBody);
      assert.equal(body.includeSpreadsheetInResponse, false);
      assert.equal(body.requests.length, 15);
      const headers = [VENDOR_COLUMNS, EVENT_COLUMNS, RECORD_COLUMNS, MAIL_COLUMNS, STAGING_COLUMNS];
      for (const [index, request] of body.requests.slice(0, 5).entries()) {
        const update = request.updateCells!;
        assert.deepEqual(update.start, { sheetId: index, rowIndex: 0, columnIndex: 0 });
        assert.equal(update.fields, "userEnteredValue");
        assert.equal(update.rows.length, 2, "第 3 列起留空，不預填否或公式");
        assert.deepEqual(update.rows[0].values.map((cell) => cell.userEnteredValue.stringValue), headers[index]);
        assert.equal(update.rows[1].values.length, headers[index].length);
        assert.ok(update.rows[1].values.every((cell) => cell.userEnteredValue.stringValue.trim() !== ""));
      }
      assert.equal(body.requests[3].updateCells!.rows[1].values[13].userEnteredValue.stringValue.includes("版本旨文"), true);
      return Response.json(initializedResponse(body));
    });
    assert.equal(result, ID);
    assert.equal(calls, 2);
  });

  it("只設定確認過的 10 處下拉，從第 3 列起套用，保留選項原文與空白資料列", async () => {
    let calls = 0;
    await createClubSpreadsheet(TOKEN, CLUB, async (_input, init) => {
      if (++calls === 1) return Response.json(createdResponse());
      const body: BatchBody = JSON.parse(String(init?.body));
      const actual = body.requests.flatMap((request) => request.setDataValidation ? [request.setDataValidation] : []);
      const expected: readonly [number, number, readonly string[]][] = [
        [0, 5, CONTACT_METHODS],
        [1, 8, ["籌備中", "招商中", "已結束", "歷史"]],
        [2, 6, ["未聯絡", "已寄出・尚未回覆", "已回覆・待處理", "洽談中", "已同意合作", "已拒絕", "待確認"]],
        [2, 7, ["繼續追蹤", "停止追蹤", "停止追蹤（限該活動）", "待確認"]],
        [3, 3, ["寄出", "收到（人工補登）"]],
        [3, 4, ["首次邀約", "催信", "其他外寄", "回覆補登"]],
        [3, 12, ["未送審", "待審核", "已核准", "已退回", "不適用"]],
        [3, 16, ["未寄送", "寄送中", "成功", "失敗", "待確認", "不適用"]],
        [4, 29, MERGE_DECISIONS], [4, 32, CONFIRM_STATUSES],
      ];
      assert.equal(actual.length, expected.length);
      expected.forEach(([sheetId, column, options], index) => {
        assert.deepEqual(actual[index], {
          range: { sheetId, startRowIndex: 2, startColumnIndex: column, endColumnIndex: column + 1 },
          rule: { condition: { type: "ONE_OF_LIST", values: options.map((value) => ({ userEnteredValue: value })) },
            strict: true, showCustomUi: true },
        });
      });
      return Response.json(initializedResponse(body));
    });
  });

  it("①②③⑤直接共用現有欄位；④保留 25 欄、ID 空格與核准版本旨文", () => {
    [VENDOR_COLUMNS, EVENT_COLUMNS, RECORD_COLUMNS, MAIL_COLUMNS, STAGING_COLUMNS].forEach((columns, index) => {
      assert.equal(SHEET_DEFINITIONS[index].columns, columns);
    });
    assert.deepEqual(MAIL_COLUMNS, [
      "信件 ID", "往來 ID", "活動 ID", "信件方向", "信件類型", "對方 Email", "主旨", "內容摘要", "完整內容版本參照",
      "附件檔名", "附件參照", "附件版本", "審核狀態", "核准版本旨文", "核准人", "核准時間", "寄送狀態", "寄送時間",
      "Gmail Message ID", "錯誤摘要", "寄送操作人", "建立人", "建立時間", "最後更新人", "最後更新時間",
    ]);
  });

  it("模擬建好的⑤通過既有欄位檢查，說明列保留，第一筆資料仍在第 3 列", async () => {
    let calls = 0;
    let table: string[][] = [];
    await createClubSpreadsheet(TOKEN, CLUB, async (_input, init) => {
      if (++calls === 1) return Response.json(createdResponse());
      const body: BatchBody = JSON.parse(String(init?.body));
      table = body.requests[4].updateCells!.rows.map((row) => row.values.map((cell) => cell.userEnteredValue.stringValue));
      assertStagingHeaders(table[0]);
      return Response.json(initializedResponse(body));
    });
    const first = STAGING_COLUMNS.map((column) => column === "暫存ID" ? "offline-row" : "");
    table.push(first);
    const rows = await readStagingRows({ readValues: async (range) => {
      assert.equal(range, `'${SHEET_NAMES.staging}'`);
      return table;
    } });
    assert.deepEqual(rows, [{ rowNumber: 3, values: first }]);
  });

  for (const [label, value] of [["空白", " "], ["換行", "offline\r\nvalue"], ["尾端換行", "offline\n"], ["非 ASCII", "離線文字"], ["null", null]] as const) {
    it(`憑證格式錯誤不發出 HTTP：${label}`, async () => {
      await assert.rejects(createClubSpreadsheet(value as string, CLUB, async () => assert.fail("不得連 Google")),
        expectError("invalid_input", "not_attempted", "create"));
    });
  }
  for (const name of ["", " \t ", "社團\n名稱", "社團\u0000名稱", "社團\u2028名稱"]) {
    it(`社團名稱無效時不發出 HTTP：${JSON.stringify(name)}`, async () => {
      await assert.rejects(createClubSpreadsheet(TOKEN, name, async () => assert.fail("不得連 Google")),
        expectError("invalid_input", "not_attempted", "create"));
    });
  }

  for (const stage of ["create", "initialize"] as const) {
    for (const status of [400, 401, 403, 408, 429, 500, 503]) {
      it(`${stage} 階段 HTTP ${status} 回報安全錯誤、不自動重試`, async () => {
        let calls = 0;
        await assert.rejects(createClubSpreadsheet(TOKEN, CLUB, async () => {
          calls++;
          if (stage === "initialize" && calls === 1) return Response.json(createdResponse());
          return new Response(`private response ${TOKEN}`, { status });
        }), expectError(status === 401 || status === 403 ? "authorization" : "request_failed",
          status >= 500 || status === 408 ? "unknown" : "rejected", stage, stage === "initialize" ? ID : undefined, status));
        assert.equal(calls, stage === "create" ? 1 : 2);
      });
    }
    it(`${stage} 階段斷線或逾時，不假設未建立、不自動刪檔或重建`, async () => {
      let calls = 0;
      await assert.rejects(createClubSpreadsheet(TOKEN, CLUB, async () => {
        calls++;
        if (stage === "initialize" && calls === 1) return Response.json(createdResponse());
        throw new Error(`private exception ${TOKEN}`);
      }), expectError("request_failed", "unknown", stage, stage === "initialize" ? ID : undefined));
      assert.equal(calls, stage === "create" ? 1 : 2);
    });
    it(`${stage} 階段成功回應卻不是 JSON，仍回報未確認`, async () => {
      let calls = 0;
      await assert.rejects(createClubSpreadsheet(TOKEN, CLUB, async () => {
        if (stage === "initialize" && ++calls === 1) return Response.json(createdResponse());
        return new Response(`not json ${TOKEN}`, { status: 200 });
      }), expectError("invalid_response", "unknown", stage, stage === "initialize" ? ID : undefined));
    });
  }

  for (const response of [null, {}, { spreadsheetId: "" }, { spreadsheetId: "../other" }, { spreadsheetId: "offline\n" }]) {
    it(`建立回應缺少有效 ID 時不繼續設定：${JSON.stringify(response)}`, async () => {
      let calls = 0;
      await assert.rejects(createClubSpreadsheet(TOKEN, CLUB, async () => {
        calls++;
        return Response.json(response);
      }), expectError("invalid_response", "unknown", "create"));
      assert.equal(calls, 1);
    });
  }

  it("已取得 ID 但五頁回應缺漏或名稱錯誤，保留 ID 供核對，不設定錯誤分頁", async () => {
    const source = createdResponse();
    const variants = [undefined, [], source.sheets.slice(1), source.sheets.map(() => source.sheets[0]),
      source.sheets.map((sheet, index) => index === 4 ? { properties: { ...sheet.properties, title: "⑤舊資料暫存" } } : sheet)];
    for (const sheets of variants) {
      let calls = 0;
      await assert.rejects(createClubSpreadsheet(TOKEN, CLUB, async () => {
        calls++;
        return Response.json({ spreadsheetId: ID, sheets });
      }), expectError("invalid_response", "unknown", "create", ID));
      assert.equal(calls, 1);
    }
  });

  for (const label of ["缺 ID", "錯 ID", "缺 replies", "缺部分 replies", "非物件 replies"] as const) {
    it(`初始化回應${label}不能當成功，仍保留已建立的 ID`, async () => {
      let calls = 0;
      await assert.rejects(createClubSpreadsheet(TOKEN, CLUB, async (_input, init) => {
        if (++calls === 1) return Response.json(createdResponse());
        const good = initializedResponse(JSON.parse(String(init?.body)));
        if (label === "缺 ID") return Response.json({ replies: good.replies });
        if (label === "錯 ID") return Response.json({ ...good, spreadsheetId: "offline-other" });
        if (label === "缺 replies") return Response.json({ spreadsheetId: ID });
        if (label === "缺部分 replies") return Response.json({ ...good, replies: good.replies.slice(1) });
        return Response.json({ ...good, replies: good.replies.map(() => null) });
      }), expectError("invalid_response", "unknown", "initialize", ID));
      assert.equal(calls, 2);
    });
  }

  it("所有失敗階段都不保留憑證、社團名稱、Google 內文或原始例外", async () => {
    for (const stage of ["create", "initialize"] as const) {
      let calls = 0;
      await assert.rejects(createClubSpreadsheet(TOKEN, CLUB, async () => {
        if (stage === "initialize" && ++calls === 1) return Response.json(createdResponse());
        throw new Error(`private exception ${TOKEN} ${CLUB}`);
      }), (error: unknown) => {
        assert.ok(error instanceof SpreadsheetCreationError);
        const printable = `${String(error)} ${JSON.stringify(error)} ${error.stack}`;
        for (const text of [TOKEN, CLUB, "private exception"]) assert.equal(printable.includes(text), false);
        assert.equal(error.cause, undefined);
        return true;
      });
    }
  });
});
