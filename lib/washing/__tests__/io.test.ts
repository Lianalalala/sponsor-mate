import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { MockLanguageModelV4 } from "ai/test";

import {
  collectCells,
  interpretCells,
  needsInterpretation,
  suggestColumnMapping,
} from "../ai.ts";
import { EMPTY_INTERPRETATION } from "../interpretation.ts";
import { washTable, type ColumnMapping, type RawTable } from "../pipeline.ts";
import {
  decodeCsv,
  readCsv,
  readUploadedTable,
  readXlsx,
  toRawTable,
  UnsupportedFileError,
} from "../read-table.ts";
import { STAGING_COLUMNS, toStagingRow } from "../staging.ts";

const golden = JSON.parse(
  readFileSync(new URL("./golden.json", import.meta.url), "utf8"),
) as { raw: string[][] };

function mockModel(json: unknown, seen: string[] = []) {
  return new MockLanguageModelV4({
    doGenerate: async (options) => {
      seen.push(JSON.stringify(options.prompt));
      return {
        content: [{ type: "text", text: JSON.stringify(json) }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
}

describe("讀 CSV", () => {
  it("UTF-8 含 BOM", () => {
    const [{ table }] = readCsv(new TextEncoder().encode("﻿廠商,聯絡\n全家,a@example.com\n"));
    assert.deepEqual(table.headers, ["廠商", "聯絡"]);
    assert.deepEqual(table.rows, [["全家", "a@example.com"]]);
    assert.equal(table.firstDataRowNumber, 2);
  });

  it("Big5 編碼（Excel 另存的 CSV）", () => {
    // 「全家」的 Big5 編碼
    const big5 = new Uint8Array([0xa5, 0xfe, 0xae, 0x61]);
    assert.equal(decodeCsv(big5), "全家");
  });

  it("中間的空白列要留著，列號才對得起來", () => {
    const [{ table }] = readCsv(new TextEncoder().encode("廠商,聯絡\n甲,a@example.com\n,\n乙,b@example.com\n"));
    assert.equal(table.rows.length, 3);
  });
});

describe("找標題列", () => {
  it("略過最上面的大標題，列號仍對應原檔", () => {
    const table = toRawTable([
      ["112 學年招商名單", ""],
      ["", ""],
      ["廠商", "聯絡"],
      ["甲", "a@example.com"],
    ]);
    assert.deepEqual(table?.headers, ["廠商", "聯絡"]);
    assert.equal(table?.firstDataRowNumber, 4);
  });
  it("只有一欄的名單也讀得到", () => {
    const table = toRawTable([["廠商"], ["甲"], ["乙"]]);
    assert.deepEqual(table?.headers, ["廠商"]);
    assert.equal(table?.rows.length, 2);
  });
  it("空表回傳 null", () => {
    assert.equal(toRawTable([[""]]), null);
  });
});

describe("讀 Excel", () => {
  it("真的 .xlsx：日期格變成 ISO 文字、數字變字串、多分頁都讀", async () => {
    const bytes = readFileSync(new URL("./sample.xlsx", import.meta.url));
    const sheets = await readXlsx(bytes);
    assert.deepEqual(sheets.map(({ sheetName }) => sheetName), ["舊名單", "第二頁"]);
    assert.deepEqual(sheets[0].table.headers, ["廠商", "聯絡", "日期", "金額"]);
    assert.deepEqual(sheets[0].table.rows[0], ["全家", "a@example.com", "2025-09-15", "3000"]);
  });

  it("舊版 .xls 要給清楚的提示", async () => {
    const bytes = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]);
    await assert.rejects(readUploadedTable("舊.xls", bytes), UnsupportedFileError);
  });

  it("副檔名是 .xlsx 但內容不是，不會硬讀", async () => {
    await assert.rejects(readUploadedTable("假.xlsx", Buffer.from("not a zip")), UnsupportedFileError);
  });

  it("超過大小上限", async () => {
    await assert.rejects(readUploadedTable("大.csv", Buffer.alloc(4 * 1024 * 1024 + 1)), UnsupportedFileError);
  });
});

const table: RawTable = {
  headers: ["店家", "聯絡", "沒用的欄"],
  rows: [["全家", "窗口：小明；a@example.com", "x"]],
};

describe("AI 欄位對應", () => {
  it("只送欄位名稱和範例，轉成 ColumnMapping，標出沒把握與沒對應的欄", async () => {
    const seen: string[] = [];
    const longRow = "長".repeat(100);
    const model = mockModel(
      {
        columns: [
          { column: 0, field: "vendorName", confident: true },
          { column: 1, field: "contact", confident: false },
          { column: 2, field: null, confident: true },
          { column: 99, field: "notes", confident: true },
        ],
      },
      seen,
    );
    const result = await suggestColumnMapping(model, {
      ...table,
      rows: [...table.rows, ["甲", longRow, ""], ["乙", "b", ""], ["丙", "c", ""], ["第五家", "d", ""]],
    });
    assert.deepEqual(result.mapping, { vendorName: [0], contact: [1] });
    assert.deepEqual(result.uncertainColumns, [1]);
    assert.deepEqual(result.unmappedColumns, [2]);
    assert.ok(!seen[0].includes("第五家"), "不該送整份表");
    assert.ok(!seen[0].includes("長".repeat(41)), "範例要截短");
  });
});

describe("AI 拆解", () => {
  const cells = [
    { rowNumber: 2, contact: "窗口：小明；a@example.com", sponsorship: "飲料 50 杯" },
    { rowNumber: 3, contact: "b@example.com", sponsorship: "" },
    { rowNumber: 4, contact: "LINE：@x", sponsorship: "" },
  ];

  it("純 Email 又沒有贊助的列不送 AI", () => {
    assert.deepEqual(cells.map(needsInterpretation), [true, false, true]);
  });

  it("回傳列號對應；陌生列號丟掉；漏掉的列要回報", async () => {
    const row = { ...EMPTY_INTERPRETATION, contactPerson: "小明", rowNumber: 2 };
    const { interpretations, missingRows } = await interpretCells(
      mockModel({ rows: [row, { ...row, rowNumber: 77 }] }),
      cells,
    );
    assert.equal(interpretations.get(2)?.contactPerson, "小明");
    assert.equal(interpretations.has(77), false);
    assert.deepEqual(missingRows, [4]);
  });

  it("AI 無中生有的 Email 進不來：Email 只由程式從原文抽", async () => {
    const mapping: ColumnMapping = { vendorName: [0], contact: [1] };
    const { interpretations } = await interpretCells(
      mockModel({
        rows: [{ ...EMPTY_INTERPRETATION, contactPerson: "憑空的人", rowNumber: 2 }],
      }),
      collectCells(table, mapping),
    );
    const { rows } = washTable(table, mapping, interpretations);
    assert.equal(rows[0].interpretation.contactPerson, null);
    assert.equal(rows[0].email.value, "a@example.com");
  });
});

describe("暫存列", () => {
  const [headers, ...rows] = golden.raw;
  const { rows: washed } = washTable(
    { headers, rows },
    {
      legacyId: [0],
      vendorName: [1],
      contact: [2],
      contactDate: [3],
      status: [4],
      sponsorship: [5],
      eventLabel: [6],
      owner: [7],
      notes: [8],
    },
  );
  const context = { batchId: "B1", sourceName: "舊.xlsx", createdAt: "2026-11-09", createdBy: "Liana" };
  const cell = (row: (typeof washed)[number], column: (typeof STAGING_COLUMNS)[number]) =>
    toStagingRow(row, context)[STAGING_COLUMNS.indexOf(column)];

  it("欄數與資料表⑤一致（35 欄）", () => {
    assert.equal(STAGING_COLUMNS.length, 35);
    assert.equal(toStagingRow(washed[0], context).length, 35);
  });

  it("活動與合併一定留給公關長", () => {
    for (const row of washed) {
      assert.equal(cell(row, "對應活動ID"), "");
      assert.equal(cell(row, "合併決定"), "");
      assert.equal(cell(row, "確認狀態"), "待確認");
    }
  });

  it("保留可追溯的原文與列號", () => {
    const row = washed[3];
    assert.equal(cell(row, "原始列號"), 5);
    assert.equal(JSON.parse(String(cell(row, "原始資料")))["公司／店家"], "青丘烘焙　");
  });

  it("停止聯絡會帶到暫存", () => {
    assert.equal(cell(washed[10], "廠商停止聯絡"), "是");
  });
});
