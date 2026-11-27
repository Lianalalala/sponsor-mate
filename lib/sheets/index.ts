import "server-only";

import { createSheetsTransport, type SheetsConnection } from "./transport.ts";
import { createClubSpreadsheet as createSpreadsheetRequest } from "./create-spreadsheet.ts";

export { SheetsError } from "./transport.ts";
export type { SheetCell, SheetsConnection } from "./transport.ts";
export { assertStagingHeaders } from "./staging-schema.ts";
export { readStagingRows, StagingColumnCountError } from "./staging-read.ts";
export type { StagingReadClient, StagingSheetRow } from "./staging-read.ts";
export { readPendingStagingRows } from "./staging-pending.ts";
export { SpreadsheetCreationError } from "./create-spreadsheet.ts";
export type { SpreadsheetCreationStage } from "./create-spreadsheet.ts";
export { SHEET_NAMES, MAIL_COLUMNS } from "./schema.ts";

// accessToken 必須是呼叫端驗證後提供的社團憑證；spreadsheetId 由呼叫端另行保存。
export function createClubSpreadsheet(accessToken: string, clubName: string): Promise<string> {
  return createSpreadsheetRequest(accessToken, clubName, (...args) => fetch(...args));
}

// 內部底層，沒有 Server Action 或公開 API。
// 待社團 OAuth／Neon 綁定完成後，由 DAL 在驗證 session、社團及操作權限後建立。
export function createSheetsClient(connection: SheetsConnection) {
  return createSheetsTransport(connection, (...args) => fetch(...args));
}
