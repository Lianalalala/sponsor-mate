import { isLocalRequest } from "@/lib/dev-only";
import { readUploadedTable, UnsupportedFileError, type NamedTable } from "@/lib/washing/read-table";

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
    throw new UserFacingError("AI 沒有回應。請確認 .env.local 的 ANTHROPIC_API_KEY，再試一次", 502);
  }
}

export function localOnly(
  handler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (!isLocalRequest(request)) return new Response(null, { status: 404 });
    try {
      return await handler(request);
    } catch (error) {
      if (error instanceof UserFacingError) {
        return Response.json({ error: error.message }, { status: error.status });
      }
      console.error("washing: 未預期的錯誤", error instanceof Error ? error.name : "unknown");
      return Response.json({ error: "處理時發生錯誤，請再試一次" }, { status: 500 });
    }
  };
}
