// 社團 access token（D-027）。只能在伺服器端 import。
//
// 蘇的 Sheets 讀寫、建表，之後的 Gmail 寄送，每次呼叫 Google 前都要社團帳號的 access token
// （個人登入的 token 沒有 gmail.send、drive.file，不能用）。流程：
//   1. 從 club_connection 讀出這個社團的加密 refresh token
//   2. 解密（綁定「club_refresh_token＋社團ID」，跟 complete.ts 寫入時一樣）
//   3. 向 Google 換 access token（oauth.ts 的 refreshAccessToken）
//   4. 成功 → 更新 last_refreshed_at；invalid_grant → 清掉 token、填 revoked_at
//      網路斷線、Google 5xx 等暫時錯誤 → 只回報錯誤，不清 token
//
// 換到的 access token 放在伺服器記憶體裡，到期前 5 分鐘才重新換（Sheets 每個操作都會來拿一次）。
// 代價：社團在 Google 撤銷授權後，暫存的 token 最多再被拿去用不到 1 小時；Google 會直接拒絕，
// Sheets 回 authorization 錯誤，不會寫錯資料。
//
// 這個檔案不讀環境變數；資料庫、Google 請求、時間都由呼叫端傳入，測試時換成假的。
// 錯誤訊息一律是固定文字，不包含 token、client secret 或 Google 回應的內容。

import type { Kysely } from "kysely";

import { bindingFor, decryptSecret } from "../crypto/secret-box.ts";
import { connectionState, type Database } from "../db/index.ts";
import { refreshAccessToken } from "./oauth.ts";

export type ClubTokenErrorCode =
  | "not_connected"
  | "revoked"
  | "invalid_state"
  | "decrypt_failed"
  | "missing_scopes"
  | "temporary_failure";

const MESSAGES: Record<ClubTokenErrorCode, string> = {
  not_connected: "這個社團還沒連接社團 Google 帳號，請公關長從首頁連接",
  revoked: "社團 Google 帳號的授權已失效，請公關長從首頁重新連接",
  invalid_state: "社團授權資料狀態不正確，請聯絡開發者",
  decrypt_failed: "社團授權資料無法讀取，請聯絡開發者",
  missing_scopes: "社團授權不完整：寄信（Gmail）和試算表（Google Drive）兩項權限都要有，請公關長重新連接",
  temporary_failure: "暫時無法取得社團 Google 授權，請稍後再試",
};

export function clubTokenErrorMessage(code: ClubTokenErrorCode): string {
  return MESSAGES[code];
}

export class ClubTokenError extends Error {
  readonly code: ClubTokenErrorCode;

  constructor(code: ClubTokenErrorCode) {
    super(MESSAGES[code]);
    this.name = "ClubTokenError";
    this.code = code;
  }
}

// ───────────────────────── 資料庫 ─────────────────────────

export interface StoredConnection {
  encryptedRefreshToken: string | null;
  revokedAt: Date | null;
}

/** getAccessToken 用到的資料庫操作；正式環境用 dbClubTokenStore，測試用假的 */
export interface ClubTokenStore {
  /** 沒有這個社團的連接時回傳 null */
  read(clubId: string): Promise<StoredConnection | null>;
  markRefreshed(clubId: string, at: Date): Promise<void>;
  /**
   * 清掉 token、填撤銷時間。只在 token 還是剛剛讀到的那一個時才改，
   * 避免蓋掉同時寫入的新授權。有改到回傳 true。
   */
  markRevoked(clubId: string, encryptedRefreshToken: string, at: Date): Promise<boolean>;
}

export function dbClubTokenStore(db: Kysely<Database>): ClubTokenStore {
  return {
    async read(clubId) {
      const row = await db
        .selectFrom("club_connection")
        .select(["encrypted_refresh_token", "revoked_at"])
        .where("club_id", "=", clubId)
        .executeTakeFirst();
      if (!row) return null;
      return { encryptedRefreshToken: row.encrypted_refresh_token, revokedAt: row.revoked_at };
    },

    async markRefreshed(clubId, at) {
      await db
        .updateTable("club_connection")
        .set({ last_refreshed_at: at })
        .where("club_id", "=", clubId)
        .where("revoked_at", "is", null)
        .execute();
    },

    async markRevoked(clubId, encryptedRefreshToken, at) {
      const result = await db
        .updateTable("club_connection")
        .set({ encrypted_refresh_token: null, revoked_at: at })
        .where("club_id", "=", clubId)
        .where("encrypted_refresh_token", "=", encryptedRefreshToken)
        .executeTakeFirst();
      return result.numUpdatedRows > BigInt(0);
    },
  };
}

// ───────────────────────── 取得 access token ─────────────────────────

/** 到期前多久就重新換，避免拿到一張馬上過期的 token */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface ClubTokenDeps {
  store: ClubTokenStore;
  key: Buffer;
  clientId: string;
  clientSecret: string;
  fetcher: typeof fetch;
  now: () => number;
}

export interface ClubTokenProvider {
  /** 拿社團目前有效的 access token；拿不到時拋 ClubTokenError */
  getAccessToken(clubId: string): Promise<string>;
  /** 丟掉這個社團的暫存（例如 Google 回 401 之後），下次會重新換 */
  forget(clubId: string): void;
}

export function createClubTokenProvider(deps: ClubTokenDeps): ClubTokenProvider {
  const cache = new Map<string, { accessToken: string; expiresAt: number }>();
  // 同一個社團同時有好幾個請求時，只向 Google 換一次
  const inflight = new Map<string, Promise<string>>();

  async function refresh(clubId: string): Promise<string> {
    const stored = await deps.store.read(clubId);
    if (!stored) throw new ClubTokenError("not_connected");

    const state = connectionState({
      encrypted_refresh_token: stored.encryptedRefreshToken,
      revoked_at: stored.revokedAt,
    });
    if (state === "revoked") throw new ClubTokenError("revoked");
    if (state !== "active") throw new ClubTokenError("invalid_state");
    const encrypted = stored.encryptedRefreshToken as string;

    let refreshToken: string;
    try {
      refreshToken = decryptSecret(encrypted, deps.key, bindingFor("club_refresh_token", clubId));
    } catch {
      // 多半是鑰匙換了或設錯；不清 token，修好鑰匙就能繼續用
      throw new ClubTokenError("decrypt_failed");
    }

    const result = await refreshAccessToken(
      { refreshToken, clientId: deps.clientId, clientSecret: deps.clientSecret },
      deps.fetcher,
    );

    if (!result.ok) {
      if (result.reason === "revoked") {
        // 沒用的 token 不留在資料庫（D-027）。沒改到代表同時有新授權寫進來，一樣回報這次失效
        await deps.store.markRevoked(clubId, encrypted, new Date(deps.now()));
        throw new ClubTokenError("revoked");
      }
      if (result.reason === "missing_scopes") throw new ClubTokenError("missing_scopes");
      throw new ClubTokenError("temporary_failure");
    }

    const now = deps.now();
    try {
      await deps.store.markRefreshed(clubId, new Date(now));
    } catch {
      // 只是記錄時間，寫不進去不影響這次拿到的 token
    }

    const expiresAt = now + result.expiresInSeconds * 1000;
    if (expiresAt - REFRESH_MARGIN_MS > now) {
      cache.set(clubId, { accessToken: result.accessToken, expiresAt });
    }
    return result.accessToken;
  }

  return {
    async getAccessToken(clubId) {
      if (typeof clubId !== "string" || clubId === "") throw new ClubTokenError("not_connected");

      const cached = cache.get(clubId);
      if (cached && cached.expiresAt - REFRESH_MARGIN_MS > deps.now()) return cached.accessToken;
      cache.delete(clubId);

      const running = inflight.get(clubId);
      if (running) return running;

      const promise = refresh(clubId).finally(() => inflight.delete(clubId));
      inflight.set(clubId, promise);
      return promise;
    },

    forget(clubId) {
      cache.delete(clubId);
    },
  };
}
