// Data washing machine 的 API 共用部分：權限檢查、讀上傳檔案、呼叫 AI、錯誤處理。
// 只能在伺服器端 import。
//
// 檔案只在記憶體裡處理，不寫進硬碟、不存資料庫；回應送出後就丟掉，
// 所以「洗完清掉伺服器暫存」不需要另外刪檔。錯誤紀錄也只記錯誤類型，不記內容。

import { checkImportAccess, type ImportAccess } from "../current-member.ts";
import { isLocalRequest } from "../dev-only.ts";
import { readUploadedTable, UnsupportedFileError, type NamedTable } from "./read-table.ts";

export class UserFacingError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface UploadedSheets {
  fileName: string;
  sheets: NamedTable[];
  form: FormData;
}

export async function readUpload(request: Request): Promise<UploadedSheets> {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new UserFacingError("請先選擇檔案");

  let sheets: NamedTable[];
  try {
    sheets = await readUploadedTable(file.name, Buffer.from(await file.arrayBuffer()));
  } catch (error) {
    if (error instanceof UnsupportedFileError) throw new UserFacingError(error.message);
    throw new UserFacingError("這個檔案讀不出來，請確認檔案沒有損毀，或另存一份再試");
  }
  if (sheets.length === 0) throw new UserFacingError("檔案裡沒有找到表格資料");
  return { fileName: file.name, sheets, form };
}

export function pickSheet(upload: UploadedSheets): { sheetIndex: number; sheet: NamedTable } {
  const sheetIndex = Number(upload.form.get("sheetIndex") ?? 0);
  const sheet = upload.sheets[sheetIndex];
  if (!Number.isInteger(sheetIndex) || !sheet) throw new UserFacingError("找不到這個分頁");
  return { sheetIndex, sheet };
}

/** AI 的錯誤可能帶請求內容，只記錯誤類型，不記訊息本文 */
export async function callAi<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    console.error("washing: AI 呼叫失敗", error instanceof Error ? error.name : "unknown");
    throw new UserFacingError("AI 沒有回應，請稍後再試一次", 502);
  }
}

const DENIED_MESSAGE: Record<401 | 403, string> = {
  401: "請先登入",
  403: "只有公關長可以匯入舊資料",
};

export interface WashingEndpointOptions {
  /** 本機開發工具（/dev/washing）：部署後關閉，只接受 localhost */
  localOnly?: boolean;
  /** 測試用：換掉讀 session 的方式 */
  checkAccess?: (headers: Headers) => Promise<ImportAccess>;
}

type Handler = (request: Request, access: Extract<ImportAccess, { allowed: true }>) => Promise<Response>;

/**
 * 包住每個清洗相關的 API。順序很重要：
 * 先檢查 localhost（本機工具）→ 再驗證 session 與公關長角色 → 通過才執行 handler。
 * 沒通過時 handler 完全不會執行，所以讀不到上傳的檔案，也呼叫不到 AI。
 */
export function washingEndpoint(
  handler: Handler,
  { localOnly = false, checkAccess = checkImportAccess }: WashingEndpointOptions = {},
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (localOnly && !isLocalRequest(request)) return new Response(null, { status: 404 });
    try {
      const access = await checkAccess(request.headers);
      if (!access.allowed) {
        return Response.json({ error: DENIED_MESSAGE[access.status] }, { status: access.status });
      }
      return await handler(request, access);
    } catch (error) {
      if (error instanceof UserFacingError) {
        return Response.json({ error: error.message }, { status: error.status });
      }
      console.error("washing: 未預期的錯誤", error instanceof Error ? error.name : "unknown");
      return Response.json({ error: "處理時發生錯誤，請再試一次" }, { status: 500 });
    }
  };
}
