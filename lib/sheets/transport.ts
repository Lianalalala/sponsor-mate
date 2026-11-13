// 內部 HTTP 實作。應用程式一律由 ./index.ts 的 server-only 入口使用。
// 這裡不讀環境變數、不保存 token，也不自動重試寫入。

export type SheetCell = string | number | boolean;
export type SheetsErrorCode = "invalid_input" | "authorization" | "request_failed" | "invalid_response";

export class SheetsError extends Error {
  readonly code: SheetsErrorCode;
  readonly writeOutcome: "not_attempted" | "rejected" | "unknown";
  readonly status?: number;

  constructor(
    code: SheetsErrorCode,
    writeOutcome: "not_attempted" | "rejected" | "unknown",
    status?: number,
  ) {
    // 不保留 Google 回應、原始例外、token 或儲存格內容。
    super(`Sheets 操作失敗（${code}）；寫入狀態：${writeOutcome}`);
    this.name = "SheetsError";
    this.code = code;
    this.writeOutcome = writeOutcome;
    this.status = status;
  }
}

export interface SheetsConnection {
  // 必須由伺服器查得已授權的社團綁定，不接受前端指定試算表或 token。
  spreadsheetId: string;
  // 每次操作都呼叫；由社團 OAuth 層供應仍有效的 access token。
  getAccessToken: () => Promise<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCell(value: unknown): value is SheetCell {
  return typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value));
}

/** 僅供 server-only 入口及離線測試使用；不代表已完成成員／社團授權。 */
export function createSheetsTransport(connection: SheetsConnection, fetcher: typeof fetch) {
  const spreadsheetId = connection.spreadsheetId;
  if (typeof spreadsheetId !== "string" || !/^[A-Za-z0-9_-]+$/.test(spreadsheetId)) {
    throw new SheetsError("invalid_input", "not_attempted");
  }

  async function request(range: string, rows?: SheetCell[][]): Promise<Record<string, unknown>> {
    if (typeof range !== "string" || range.trim() === "") {
      throw new SheetsError("invalid_input", "not_attempted");
    }

    let token: string;
    try {
      token = await connection.getAccessToken();
      if (typeof token !== "string" || token.trim() === "" || /[\r\n]/.test(token)) throw new Error();
    } catch {
      throw new SheetsError("authorization", "not_attempted");
    }

    const writing = rows !== undefined;
    const url = new URL(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}${writing ? ":append" : ""}`,
    );
    if (writing) {
      url.searchParams.set("valueInputOption", "RAW");
      url.searchParams.set("insertDataOption", "INSERT_ROWS");
      url.searchParams.set("includeValuesInResponse", "false");
    } else {
      url.searchParams.set("majorDimension", "ROWS");
    }

    let response: Response;
    try {
      response = await fetcher(url, {
        method: writing ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(writing ? { "Content-Type": "application/json" } : {}),
        },
        body: writing ? JSON.stringify({ range, majorDimension: "ROWS", values: rows }) : undefined,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      // 超時／斷線可能發生在 Google 已完成寫入之後，不能直接重送。
      throw new SheetsError("request_failed", writing ? "unknown" : "not_attempted");
    }

    if (!response.ok) {
      const outcome = !writing ? "not_attempted" :
        response.status >= 500 || response.status === 408 ? "unknown" : "rejected";
      throw new SheetsError(
        response.status === 401 || response.status === 403 ? "authorization" : "request_failed",
        outcome,
        response.status,
      );
    }

    try {
      const result: unknown = await response.json();
      if (!isRecord(result)) throw new Error();
      return result;
    } catch {
      throw new SheetsError("invalid_response", writing ? "unknown" : "not_attempted");
    }
  }

  return {
    /** Google 會省略尾端空白格／列；保持原樣，不補列或跳過中間空列。 */
    async readValues(range: string): Promise<SheetCell[][]> {
      const result = await request(range);
      const values = result.values === undefined ? [] : result.values;
      if (typeof result.range !== "string" || !Array.isArray(values) ||
        !values.every((row) => Array.isArray(row) && row.every(isCell))) {
        throw new SheetsError("invalid_response", "not_attempted");
      }
      return values;
    },

    /** 低階新增：呼叫端須先完成權限、確認、批次去重與併發控制。 */
    async appendRows(range: string, rows: readonly (readonly SheetCell[])[]) {
      if (!Array.isArray(rows) || rows.length === 0 ||
        !Array.from(rows).every((row) => Array.isArray(row) && row.length > 0 && Array.from(row).every(isCell))) {
        throw new SheetsError("invalid_input", "not_attempted");
      }
      const snapshot = rows.map((row) => [...row]);
      const result = await request(range, snapshot);
      const updates = result.updates;
      if (result.spreadsheetId !== spreadsheetId || !isRecord(updates) ||
        updates.updatedRows !== snapshot.length ||
        typeof updates.updatedRange !== "string" || updates.updatedRange === "") {
        throw new SheetsError("invalid_response", "unknown");
      }
      return { updatedRange: updates.updatedRange, updatedRows: snapshot.length };
    },
  };
}
