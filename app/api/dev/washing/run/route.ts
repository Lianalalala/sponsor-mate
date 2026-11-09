// 第二步：照確認過的欄位對應清洗。這裡只回傳結果，不寫入試算表。

import { getWashingModel } from "@/lib/ai/model";
import { collectCells, interpretCells } from "@/lib/washing/ai";
import { washTable, type ColumnMapping, type WashField } from "@/lib/washing/pipeline";

import { callAi, localOnly, pickSheet, readUpload, UserFacingError } from "../shared";

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

export const POST = localOnly(async (request) => {
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
});
