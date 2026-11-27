// 內部離線流程；沒有正式 adapter、HTTP 入口、環境變數或資料庫連線。
// 正式接線必須經 server-only 邊界，getActor 必須驗證 Session 與資料庫成員資格。
import { SpreadsheetCreationError, type SpreadsheetCreationStage } from "./create-spreadsheet.ts";

/** 對應後端 getCurrentUser 的必要欄位；不是認證憑證，不能採用前端自報資料。 */
export interface ProvisioningActor {
  readonly clubId: string | null;
  readonly role: "pr_lead" | "member" | null;
}

export type ProvisioningStage = SpreadsheetCreationStage | "save";

export interface ProvisioningOperation {
  readonly operationId: string;
  readonly status: "in_progress" | "needs_review" | "completed";
  /** 作業已知 ID，可能仍是半成品；不等於社團的正式綁定。 */
  readonly spreadsheetId: string | null;
}

export interface ProvisioningState {
  readonly clubId: string;
  readonly clubName: string;
  readonly spreadsheetId: string | null;
  readonly operation: ProvisioningOperation | null;
}

export type ProvisioningReservation =
  | { readonly status: "reserved"; readonly clubId: string; readonly clubName: string; readonly operationId: string }
  | { readonly status: "existing"; readonly clubId: string; readonly spreadsheetId: string }
  | { readonly status: "in_progress" | "needs_review"; readonly clubId: string;
      readonly operationId: string; readonly spreadsheetId: string | null };

export type ProvisioningReviewReason =
  | "unresolved_operation"
  | "reservation_unconfirmed"
  | "invalid_state"
  | "creation_not_attempted"
  | "creation_rejected"
  | "creation_unknown"
  | "initialization_failed"
  | "invalid_creation_response"
  | "record_id_unconfirmed"
  | "binding_unconfirmed";

/**
 * 已確認的抽象能力，不指定 Neon schema；正式資料庫 adapter 由 Liana 提供。
 * 所有寫入須以 clubId + operationId 核對作業，拒絕不同 ID、過期作業及跨社團更新。
 * Promise fulfilled 必須代表已確認提交，不能吞掉儲存錯誤。
 */
export interface ProvisioningStore {
  /** null 僅表示社團不存在；讀取失敗必須 reject，不能回傳空狀態。 */
  readState(clubId: string): Promise<ProvisioningState | null>;
  /**
   * 原子重查綁定及未決作業；只有確定已持久化資格後才回 reserved。
   * 跨程序互斥、重啟後保留及禁止逾時自動釋放，均由正式資料庫保證。
   */
  reserve(clubId: string): Promise<ProvisioningReservation>;
  recordKnownId(clubId: string, operationId: string, spreadsheetId: string, stage: ProvisioningStage): Promise<void>;
  /** 原子完成作業及 club.spreadsheet_id 綁定；相同作業、相同 ID 可重複確認。 */
  complete(clubId: string, operationId: string, spreadsheetId: string): Promise<void>;
  /**
   * 不得降級已完成作業。此更新失敗時，原本持久化的作業仍須阻止再次建表。
   * 核對／解除暫停由正式 adapter 的授權流程處理，本核心不提供釋放或重試。
   */
  markNeedsReview(clubId: string, operationId: string, reason: ProvisioningReviewReason): Promise<void>;
}

export interface ProvisioningDeps {
  getActor(): Promise<ProvisioningActor | null>;
  store: ProvisioningStore;
  /** 可由 getClubTokenProvider().getAccessToken 接入，須保留方法的呼叫方式。 */
  getAccessToken(clubId: string): Promise<string>;
  /** 正式 adapter 使用 lib/sheets/index.ts 的兩參數入口；測試注入假 HTTP。 */
  createClubSpreadsheet(accessToken: string, clubName: string): Promise<string>;
}

export type ProvisioningBlockCode =
  | "not_signed_in" | "forbidden" | "session_unavailable" | "state_unavailable"
  | "club_not_found" | "invalid_state" | "authorization_failed";

export type ProvisioningResult =
  | { readonly status: "ready"; readonly spreadsheetId: string; readonly source: "existing" | "created" }
  | { readonly status: "blocked"; readonly code: ProvisioningBlockCode }
  | { readonly status: "in_progress"; readonly operationId: string; readonly spreadsheetId: string | null }
  | { readonly status: "needs_review"; readonly reason: ProvisioningReviewReason;
      readonly operationId: string | null; readonly spreadsheetId: string | null; readonly reviewRecorded: boolean };

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
// 社團／作業識別是後端的 opaque ID，不替正式資料庫決定 UUID 或其他編碼格式。
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "" && !/[\p{Cc}\u2028\u2029]/u.test(value);
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
const nullableId = (value: unknown) => value === null || id(value);
const clubName = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "" && !/[\p{Cc}\u2028\u2029]/u.test(value);
const token = (value: unknown): value is string =>
  typeof value === "string" && value !== "" && !/[^\x21-\x7e]/u.test(value);
const blocked = (code: ProvisioningBlockCode): ProvisioningResult => ({ status: "blocked", code });
const review = (
  reason: ProvisioningReviewReason, operationId: string | null = null,
  spreadsheetId: string | null = null, reviewRecorded = false,
): ProvisioningResult => ({ status: "needs_review", reason, operationId, spreadsheetId, reviewRecorded });

function validState(value: unknown, clubId: string): value is ProvisioningState {
  if (!record(value) || value.clubId !== clubId || !clubName(value.clubName) ||
    !nullableId(value.spreadsheetId)) return false;
  const operation = value.operation;
  if (operation === null) return true; // 支援尚未有作業紀錄的既有綁定。
  if (!record(operation) || !identifier(operation.operationId) || !nullableId(operation.spreadsheetId)) return false;
  if (operation.status === "completed") {
    return id(value.spreadsheetId) && operation.spreadsheetId === value.spreadsheetId;
  }
  return (operation.status === "in_progress" || operation.status === "needs_review") && value.spreadsheetId === null;
}

/** 空社團才回 null，任何未決作業都不視為可建立。 */
function settledState(state: ProvisioningState): ProvisioningResult | null {
  if (state.spreadsheetId !== null) return { status: "ready", spreadsheetId: state.spreadsheetId, source: "existing" };
  const operation = state.operation;
  if (operation === null) return null;
  return operation.status === "needs_review"
    ? review("unresolved_operation", operation.operationId, operation.spreadsheetId, true)
    : { status: "in_progress", operationId: operation.operationId, spreadsheetId: operation.spreadsheetId };
}

function validReservation(value: unknown, clubId: string): value is ProvisioningReservation {
  if (!record(value) || value.clubId !== clubId) return false;
  if (value.status === "existing") return id(value.spreadsheetId);
  if (!identifier(value.operationId)) return false;
  if (value.status === "reserved") return clubName(value.clubName);
  return (value.status === "in_progress" || value.status === "needs_review") && nullableId(value.spreadsheetId);
}

/**
 * 單次流程，不自動重試。正式權限／儲存／token／Google 都必須由可信的伺服器依賴提供。
 * 回傳只含固定代碼與作業／試算表識別，不保留原始例外、token 或 Google 回應。
 */
export async function provisionClubSpreadsheet(deps: ProvisioningDeps): Promise<ProvisioningResult> {
  let actor: ProvisioningActor | null;
  try {
    actor = await deps.getActor();
  } catch {
    return blocked("session_unavailable");
  }
  if (actor === null) return blocked("not_signed_in");
  if (!record(actor) || actor.role !== "pr_lead" || !identifier(actor.clubId)) return blocked("forbidden");
  const clubId = actor.clubId;

  let state: ProvisioningState | null;
  try {
    state = await deps.store.readState(clubId);
  } catch {
    return blocked("state_unavailable");
  }
  if (state === null) return blocked("club_not_found");
  if (!validState(state, clubId)) return blocked("invalid_state");
  const settled = settledState(state);
  if (settled) return settled;

  let accessToken: string;
  try {
    accessToken = await deps.getAccessToken(clubId);
    if (!token(accessToken)) return blocked("authorization_failed");
  } catch {
    return blocked("authorization_failed");
  }

  let reservation: ProvisioningReservation;
  try {
    reservation = await deps.store.reserve(clubId);
  } catch {
    // 保留資格可能已提交，但回應遺失；只重查，絕不再次 reserve 或建表。
    try {
      const current = await deps.store.readState(clubId);
      if (validState(current, clubId)) {
        const result = settledState(current);
        if (result) return result;
      }
    } catch { /* 保持未確認，不假設資格不存在。 */ }
    return review("reservation_unconfirmed");
  }
  if (!validReservation(reservation, clubId)) return review("invalid_state");
  if (reservation.status === "existing") {
    return { status: "ready", spreadsheetId: reservation.spreadsheetId, source: "existing" };
  }
  if (reservation.status !== "reserved") {
    return reservation.status === "needs_review"
      ? review("unresolved_operation", reservation.operationId, reservation.spreadsheetId, true)
      : { status: "in_progress", operationId: reservation.operationId, spreadsheetId: reservation.spreadsheetId };
  }
  const operationId = reservation.operationId;
  const name = reservation.clubName;

  async function needsReview(reason: ProvisioningReviewReason, spreadsheetId: string | null = null) {
    let recorded = false;
    try {
      await deps.store.markNeedsReview(clubId, operationId, reason);
      recorded = true;
    } catch { /* 原本作業保留仍有效；本核心沒有釋放資格的路徑。 */ }
    return review(reason, operationId, spreadsheetId, recorded);
  }

  async function recoverWrite(
    reason: "record_id_unconfirmed" | "binding_unconfirmed", knownId: string, initialized: boolean,
  ): Promise<ProvisioningResult> {
    // 寫入可能已提交；只讀回，不重寫 ID、重做 complete 或重新建立。
    try {
      const current = await deps.store.readState(clubId);
      if (initialized && validState(current, clubId) && current.spreadsheetId === knownId &&
        current.operation?.operationId === operationId && current.operation.status === "completed") {
        return { status: "ready", spreadsheetId: knownId, source: "created" };
      }
    } catch { /* 無法核對就保留作業，交給正式恢復流程。 */ }
    return needsReview(reason, knownId);
  }

  let spreadsheetId: string;
  try {
    spreadsheetId = await deps.createClubSpreadsheet(accessToken, name);
  } catch (error) {
    const creationError = error instanceof SpreadsheetCreationError ? error : null;
    const stage = creationError?.stage === "initialize" ? "initialize" : "create";
    const errorId = creationError?.spreadsheetId;
    const knownId = id(errorId) ? errorId : null;
    let reason: ProvisioningReviewReason = stage === "initialize" ? "initialization_failed" : "creation_unknown";
    if (stage === "create" && knownId === null) {
      if (creationError?.writeOutcome === "not_attempted") reason = "creation_not_attempted";
      else if (creationError?.writeOutcome === "rejected") reason = "creation_rejected";
    }
    if (knownId !== null) {
      try {
        await deps.store.recordKnownId(clubId, operationId, knownId, stage);
      } catch {
        return recoverWrite("record_id_unconfirmed", knownId, false);
      }
    }
    return needsReview(reason, knownId);
  }
  if (!id(spreadsheetId)) return needsReview("invalid_creation_response");
  try {
    await deps.store.recordKnownId(clubId, operationId, spreadsheetId, "save");
  } catch {
    return recoverWrite("record_id_unconfirmed", spreadsheetId, true);
  }
  try {
    await deps.store.complete(clubId, operationId, spreadsheetId);
  } catch {
    return recoverWrite("binding_unconfirmed", spreadsheetId, true);
  }
  return { status: "ready", spreadsheetId, source: "created" };
}
