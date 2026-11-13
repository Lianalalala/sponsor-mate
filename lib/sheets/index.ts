import "server-only";

import { createSheetsTransport, type SheetsConnection } from "./transport.ts";

export { SheetsError } from "./transport.ts";
export type { SheetCell, SheetsConnection } from "./transport.ts";

// 內部底層，沒有 Server Action 或公開 API。
// 待社團 OAuth／Neon 綁定完成後，由 DAL 在驗證 session、社團及操作權限後建立。
export function createSheetsClient(connection: SheetsConnection) {
  return createSheetsTransport(connection, (...args) => fetch(...args));
}
