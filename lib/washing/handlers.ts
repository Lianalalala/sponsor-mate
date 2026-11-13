// 清洗 API 的兩個步驟。/api/import（正式）和 /api/dev/washing（本機）共用這裡，
// 權限檢查由 http.ts 的 washingEndpoint 在呼叫這些 handler 之前處理。只能在伺服器端 import。
//
// 檔案只在記憶體裡處理：不寫進硬碟、不存資料庫，回應送出後就丟掉。

import { getWashingModel } from "../ai/model.ts";
import { collectCells, interpretCells, suggestColumnMapping } from "./ai.ts";
import { callAi, pickSheet, readUpload, UserFacingError } from "./http.ts";
import { washTable, type ColumnMapping, type WashField } from "./pipeline.ts";

const SAMPLES_PER_COLUMN = 3;

/** 第一步：讀檔，請 AI 建議欄位對應（只送欄位名稱和每欄幾個範例） */
export async function analyzeUpload(request: Request): Promise<Response> {
  const upload = await readUpload(request);
  const { sheetIndex, sheet } = pickSheet(upload);
  const { table } = sheet;

  const suggestion = await callAi(() => suggestColumnMapping(getWashingModel(), table));

  return Response.json({
    fileName: upload.fileName,
    sheetNames: upload.sheets.map(({ sheetName }) => sheetName),
    sheetIndex,
    headers: table.headers,
    rowCount: table.rows.length,
    samples: table.headers.map((_, column) =>
      [...new Set(table.rows.map((row) => (row[column] ?? "").trim()))]
        .filter((value) => value !== "")
        .slice(0, SAMPLES_PER_COLUMN),
    ),
    suggestion,
  });
}

const WASH_FIELDS: readonly WashField[] = [
  "legacyId",
  "vendorName",
  "contact",
  "contactDate",
  "status",
  "sponsorship",
  "eventLabel",
  "owner",
  "notes",
];

function parseMapping(raw: FormDataEntryValue | null): ColumnMapping {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    throw new UserFacingError("欄位對應的格式不正確");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new UserFacingError("欄位對應的格式不正確");
  }
  const mapping: ColumnMapping = {};
  for (const [field, columns] of Object.entries(parsed)) {
    if (!WASH_FIELDS.includes(field as WashField) || !Array.isArray(columns)) {
      throw new UserFacingError("欄位對應的格式不正確");
    }
    mapping[field as WashField] = columns as number[];
  }
  return mapping;
}

/** 第二步：照確認過的欄位對應清洗。這裡只回傳結果，不寫入試算表。 */
export async function runWashing(request: Request): Promise<Response> {
  const upload = await readUpload(request);
  const { sheet } = pickSheet(upload);
  const mapping = parseMapping(upload.form.get("mapping"));

  // 先用空的 AI 結果跑一次，對應有問題就在花 token 之前停下來
  try {
    washTable({ ...sheet.table, rows: [] }, mapping);
  } catch (error) {
    throw new UserFacingError(error instanceof Error ? error.message : "欄位對應的格式不正確");
  }

  const { interpretations, missingRows } = await callAi(() =>
    interpretCells(getWashingModel(), collectCells(sheet.table, mapping)),
  );
  const { rows, excluded } = washTable(sheet.table, mapping, interpretations);

  return Response.json({ headers: sheet.table.headers, rows, excluded, missingRows });
}
