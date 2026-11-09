// 用真的模型跑一次 Golden Dataset，看 AI 拆得對不對。會花一點 API 費用。
// 用法：node --env-file=.env.local scripts/try-washing.ts

import { readFileSync } from "node:fs";

import { getWashingModel } from "../lib/ai/model.ts";
import { collectCells, interpretCells, suggestColumnMapping } from "../lib/washing/ai.ts";
import { washTable, type ColumnMapping } from "../lib/washing/pipeline.ts";

const golden = JSON.parse(
  readFileSync(new URL("../lib/washing/__tests__/golden.json", import.meta.url), "utf8"),
) as { raw: string[][] };

const EXPECTED_MAPPING: ColumnMapping = {
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

// 來自「標準答案_逐筆」：[窗口, 其他管道, 現金, 品項, 數量, 單位]。08 的管道是原文備註，不比對
type ExpectedRow = [string | null, string | null, number | null, string | null, number | null, string | null];
const EXPECTED: Record<string, ExpectedRow> = {
  "01": ["測試窗口A", "LINE：官方帳號（測試）", null, "商品券", 20, "張"],
  "02": [null, null, null, null, null, null],
  "03": [null, "LINE：@demo_bakery", null, "點心", 30, "盒"],
  "04": [null, null, null, null, 30, "盒"],
  "05": ["合作部", null, null, null, null, null],
  "06": ["測試窗口B", null, null, "飲料", null, "杯"],
  "07": [null, null, 3000, null, null, null],
  "09": [null, null, null, null, null, null],
  "10": [null, "電話：未留", 5000, "海報", 100, "張"],
  "11": [null, null, null, null, null, null],
  "12": [null, null, null, "補給包", 100, "份"],
};

const [headers, ...rows] = golden.raw;
const table = { headers, rows };
const model = getWashingModel();

const suggestion = await suggestColumnMapping(model, table);
const fields = new Set([...Object.keys(EXPECTED_MAPPING), ...Object.keys(suggestion.mapping)]);
const sameMapping = [...fields].every(
  (field) =>
    JSON.stringify(suggestion.mapping[field as keyof ColumnMapping]) ===
    JSON.stringify(EXPECTED_MAPPING[field as keyof ColumnMapping]),
);
console.log(`欄位對應：${sameMapping ? "正確" : "不一致"}`);
if (!sameMapping) console.log(suggestion);
console.log(`沒把握的欄：${suggestion.uncertainColumns.join("、") || "無"}`);

const { interpretations, missingRows } = await interpretCells(
  model,
  collectCells(table, EXPECTED_MAPPING),
);
const result = washTable(table, EXPECTED_MAPPING, interpretations);

let matched = 0;
const total = Object.keys(EXPECTED).length;
for (const row of result.rows) {
  const expected = EXPECTED[row.legacyId];
  if (!expected) continue;
  const { contactPerson, otherChannels, cashNtd, item, quantity, unit } = row.interpretation;
  const actual: ExpectedRow = [contactPerson, otherChannels, cashNtd, item, quantity, unit];
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    matched += 1;
  } else {
    console.log(`舊序 ${row.legacyId}\n  預期 ${JSON.stringify(expected)}\n  實際 ${JSON.stringify(actual)}`);
  }
}
console.log(`AI 拆解：${matched}/${total} 筆符合標準答案`);
if (missingRows.length > 0) console.log(`AI 漏掉的列：${missingRows.join("、")}`);
