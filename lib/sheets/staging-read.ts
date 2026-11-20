import { STAGING_COLUMNS } from "../washing/staging.ts";
import { assertStagingHeaders } from "./staging-schema.ts";
import { SheetsError, type SheetCell } from "./transport.ts";

export interface StagingReadClient {
  readValues(range: string): Promise<SheetCell[][]>;
}

export interface StagingSheetRow {
  readonly rowNumber: number;
  readonly values: SheetCell[];
}

export class StagingColumnCountError extends SheetsError {
  readonly rowNumber: number;
  readonly expectedColumns = STAGING_COLUMNS.length;
  readonly actualColumns: number;

  constructor(rowNumber: number, actualColumns: number) {
    super("schema_mismatch", "not_attempted");
    this.name = "StagingColumnCountError";
    this.rowNumber = rowNumber;
    this.actualColumns = actualColumns;
    this.message = `⑤舊資料暫存第 ${rowNumber} 列有 ${actualColumns} 欄，預期 ${this.expectedColumns} 欄，請核對試算表。`;
  }
}

/**
 * 供 DAL 使用的內部唯讀函式；呼叫端須先完成社團與角色授權。
 * 核對同一次回應的標題與資料，排除第 1、2 列並保留實際列號。
 */
export async function readStagingRows(client: StagingReadClient): Promise<StagingSheetRow[]> {
  // 固定⑤分頁，讀取完整欄位以偵測 AI 之後多出的標題或資料。
  const table = await client.readValues("'5. 舊資料暫存'");
  assertStagingHeaders(table[0]);

  const dataRows = table.slice(2);
  const oversizedIndex = dataRows.findIndex((row) => row.length > STAGING_COLUMNS.length);
  if (oversizedIndex !== -1) {
    throw new StagingColumnCountError(oversizedIndex + 3, dataRows[oversizedIndex].length);
  }

  return dataRows.map((values, index) => ({ rowNumber: index + 3, values: [...values] }));
}
