import { STAGING_COLUMNS } from "../washing/staging.ts";
import { SheetsError } from "./transport.ts";

/**
 * 核對⑤完整第一列的欄位名稱與順序（D-024／D-025）。
 * 只做離線比對；由 DAL 在讀寫資料列前呼叫，不代替授權或版本檢查。
 */
export function assertStagingHeaders(headers: unknown): void {
  if (!Array.isArray(headers) || headers.length !== STAGING_COLUMNS.length ||
    !STAGING_COLUMNS.every((column, index) => headers[index] === column)) {
    throw new SheetsError("schema_mismatch", "not_attempted");
  }
}
