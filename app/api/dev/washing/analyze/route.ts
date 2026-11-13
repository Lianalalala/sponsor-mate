// 第一步：讀檔，請 AI 建議欄位對應。檔案不會存在伺服器上。

import { getWashingModel } from "@/lib/ai/model";
import { suggestColumnMapping } from "@/lib/washing/ai";

import { callAi, pickSheet, readUpload, washingEndpoint } from "@/lib/washing/http";

const SAMPLES_PER_COLUMN = 3;

export const POST = washingEndpoint(async (request) => {
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
}, { localOnly: true });
