// 內部實作與離線測試入口；應用程式須從 ./index.ts 的 server-only 入口呼叫。
import { SHEET_DEFINITIONS } from "./schema.ts";
import { SheetsError, type SheetsErrorCode } from "./transport.ts";

export type SpreadsheetCreationStage = "create" | "initialize";

/** 不保留 token、社團名稱、HTTP 內文或原始例外；已知 ID 供後端核對半成品。 */
export class SpreadsheetCreationError extends SheetsError {
  readonly stage: SpreadsheetCreationStage;
  readonly spreadsheetId?: string;

  constructor(
    code: SheetsErrorCode,
    writeOutcome: SheetsError["writeOutcome"],
    stage: SpreadsheetCreationStage,
    spreadsheetId?: string,
    status?: number,
  ) {
    super(code, writeOutcome, status);
    this.name = "SpreadsheetCreationError";
    this.stage = stage;
    this.spreadsheetId = spreadsheetId;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && !/[^A-Za-z0-9_-]/u.test(value);

/** 接受已驗證的社團 access token，不取得／更新 token、不寫資料庫、不自動重試。 */
export async function createClubSpreadsheet(
  accessToken: string,
  clubName: string,
  fetcher: typeof fetch,
): Promise<string> {
  if (typeof accessToken !== "string" || accessToken.length === 0 || /[^\x21-\x7e]/u.test(accessToken) ||
    typeof clubName !== "string" || clubName.trim() === "" || /[\p{Cc}\u2028\u2029]/u.test(clubName)) {
    throw new SpreadsheetCreationError("invalid_input", "not_attempted", "create");
  }

  async function postJson(url: URL, body: unknown, stage: SpreadsheetCreationStage, id?: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetcher(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new SpreadsheetCreationError("request_failed", "unknown", stage, id);
    }
    if (!response.ok) {
      const outcome = response.status >= 500 || response.status === 408 ? "unknown" : "rejected";
      throw new SpreadsheetCreationError(
        response.status === 401 || response.status === 403 ? "authorization" : "request_failed",
        outcome, stage, id, response.status,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new SpreadsheetCreationError("invalid_response", "unknown", stage, id);
    }
  }

  const createUrl = new URL("https://sheets.googleapis.com/v4/spreadsheets");
  createUrl.searchParams.set("fields", "spreadsheetId,sheets.properties(sheetId,title)");
  const created = await postJson(createUrl, {
    properties: { title: `${clubName.trim()}｜sponsor-mate 資料庫`, locale: "zh_TW", timeZone: "Asia/Taipei" },
    sheets: SHEET_DEFINITIONS.map((sheet, index) => ({ properties: {
      sheetId: sheet.sheetId, title: sheet.title, index,
      gridProperties: { rowCount: 1000, columnCount: sheet.columns.length, frozenRowCount: 2 },
    } })),
  }, "create");
  if (!isRecord(created) || !isId(created.spreadsheetId)) {
    throw new SpreadsheetCreationError("invalid_response", "unknown", "create");
  }
  const id = created.spreadsheetId;
  const sheets = created.sheets;
  if (!Array.isArray(sheets) || sheets.length !== SHEET_DEFINITIONS.length ||
    !SHEET_DEFINITIONS.every((expected) => sheets.some((actual: unknown) =>
      isRecord(actual) && isRecord(actual.properties) &&
      actual.properties.sheetId === expected.sheetId && actual.properties.title === expected.title,
    ))) {
    throw new SpreadsheetCreationError("invalid_response", "unknown", "create", id);
  }

  // 同一批次寫入兩列純文字及資料區下拉；不預填資料列、不使用 formulaValue。
  const headersAndNotes = SHEET_DEFINITIONS.map((sheet) => ({ updateCells: {
    start: { sheetId: sheet.sheetId, rowIndex: 0, columnIndex: 0 },
    rows: [sheet.columns, sheet.columns.map((column) => sheet.notes[column])].map((row) => ({
      values: row.map((value) => ({ userEnteredValue: { stringValue: value } })),
    })),
    fields: "userEnteredValue",
  } }));
  const validations = SHEET_DEFINITIONS.flatMap((sheet) => sheet.dropdowns.map((dropdown) => ({ setDataValidation: {
    range: { sheetId: sheet.sheetId, startRowIndex: 2,
      startColumnIndex: sheet.columns.indexOf(dropdown.column), endColumnIndex: sheet.columns.indexOf(dropdown.column) + 1 },
    rule: { condition: { type: "ONE_OF_LIST", values: dropdown.values.map((value) => ({ userEnteredValue: value })) },
      strict: true, showCustomUi: true },
  } })));
  const requests = [...headersAndNotes, ...validations];
  const initialized = await postJson(new URL(`https://sheets.googleapis.com/v4/spreadsheets/${id}:batchUpdate`), {
    requests, includeSpreadsheetInResponse: false,
  }, "initialize", id);
  if (!isRecord(initialized) || initialized.spreadsheetId !== id ||
    !Array.isArray(initialized.replies) || initialized.replies.length !== requests.length ||
    !Array.from(initialized.replies).every(isRecord)) {
    throw new SpreadsheetCreationError("invalid_response", "unknown", "initialize", id);
  }
  return id;
}
