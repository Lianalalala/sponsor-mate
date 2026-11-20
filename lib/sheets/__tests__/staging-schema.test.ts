import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { STAGING_COLUMNS } from "../../washing/staging.ts";
import { assertStagingHeaders } from "../staging-schema.ts";
import { SheetsError } from "../transport.ts";

function assertMismatch(headers: unknown) {
  assert.throws(() => assertStagingHeaders(headers), (error: unknown) => {
    assert.ok(error instanceof SheetsError);
    assert.equal(error.code, "schema_mismatch");
    assert.equal(error.writeOutcome, "not_attempted");
    assert.equal(error.status, undefined);
    return true;
  });
}

describe("⑤舊資料暫存的欄位核對（完全離線）", () => {
  it("接受正確的 35 欄，凍結輸入及重複核對都不改動欄位", () => {
    const headers = Object.freeze([...STAGING_COLUMNS]);
    assert.equal(headers.length, 35);
    assert.equal(assertStagingHeaders(headers), undefined);
    assert.equal(assertStagingHeaders(headers), undefined);
    assert.deepEqual(headers, STAGING_COLUMNS);
  });

  it("擋下 D-024 以前缺少三個聯絡欄位的 32 欄版本", () => {
    const contactColumns = new Set(["主要聯絡方式", "主要聯絡資訊", "聯絡備註"]);
    const headers = STAGING_COLUMNS.filter((column) => !contactColumns.has(column));
    assert.equal(headers.length, 32);
    assertMismatch(headers);
  });

  it("擋下缺少中間欄位或最後一欄的資料", () => {
    assertMismatch(STAGING_COLUMNS.filter((column) => column !== "Email"));
    assertMismatch(STAGING_COLUMNS.slice(0, -1));
  });

  it("擋下 AI 後多出的欄位，包括額外空白格", () => {
    assertMismatch([...STAGING_COLUMNS, "額外欄位"]);
    assertMismatch([...STAGING_COLUMNS, ""]);
  });

  it("欄位齊全但順序不同仍阻擋，並保持原輸入不變", () => {
    const headers = [...STAGING_COLUMNS];
    [headers[0], headers[1]] = [headers[1], headers[0]];
    const snapshot = [...headers];
    assertMismatch(headers);
    assert.deepEqual(headers, snapshot);
  });

  it("擋下欄數正確但名稱重複的資料", () => {
    const headers = [...STAGING_COLUMNS];
    headers[1] = headers[0];
    assertMismatch(headers);
  });

  for (const name of ["EMAIL", "Email ", " Email", "Email\n", ""]) {
    it(`不把不同名稱或空白默默視為 Email：${JSON.stringify(name)}`, () => {
      const headers: string[] = [...STAGING_COLUMNS];
      headers[STAGING_COLUMNS.indexOf("Email")] = name;
      assertMismatch(headers);
    });
  }

  for (const [label, value] of [
    ["數字", 1], ["布林值", true], ["null", null], ["undefined", undefined], ["物件", {}],
  ] as const) {
    it(`擋下欄名中的${label}，不強制轉成字串`, () => {
      const headers: unknown[] = [...STAGING_COLUMNS];
      headers[0] = value;
      assertMismatch(headers);
    });
  }

  for (const [label, value] of [
    ["空陣列", []], ["null", null], ["undefined", undefined],
    ["字串", "暫存ID"], ["物件", {}], ["整張表", [[...STAGING_COLUMNS]]],
  ] as const) {
    it(`擋下無法當作標題列的${label}`, () => {
      assertMismatch(value);
    });
  }

  it("擋下長度正確但含有空洞的陣列", () => {
    const headers: unknown[] = [...STAGING_COLUMNS];
    delete headers[0];
    assertMismatch(headers);
  });

  it("錯誤不保留原始欄名或原始例外", () => {
    const privateDetail = "僅供離線測試的原始儲存格內容";
    const headers = [...STAGING_COLUMNS, privateDetail];
    assert.throws(() => assertStagingHeaders(headers), (error: unknown) => {
      assert.ok(error instanceof SheetsError);
      assert.equal(error.code, "schema_mismatch");
      assert.equal(error.message.includes(privateDetail), false);
      assert.equal(error.cause, undefined);
      assert.equal(JSON.stringify(error).includes(privateDetail), false);
      return true;
    });
  });
});
