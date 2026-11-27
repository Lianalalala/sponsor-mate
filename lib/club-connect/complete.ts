// 「完成連接」寫進資料庫（D-020、D-027）。只能在伺服器端 import。
//
// 在同一個交易（transaction）裡做三件事，任何一步失敗就全部取消，不會只做一半：
//   1. 建立社團（名稱是公關長連接前填的）
//   2. 存社團連接：refresh token 用 lib/crypto 加密，綁定這個社團
//   3. 把完成連接的人加為該社團公關長
//
// 擋下的情況（不改任何資料）：
// - 發起人已經屬於某個社團（一人只屬於一個社團，11/20 決定）
// - 這個社團 Google 帳號已經連接過某個社團。
//   「重新連接後原公關長怎麼處理」還沒決定（決策紀錄待定事項），定案前一律擋下。
//
// 兩個人同時用同一個帳號連接時，資料庫的唯一性規則只會讓其中一個成功，另一個也回「擋下」。

import type { Kysely, Transaction } from "kysely";

import { bindingFor, encryptSecret } from "../crypto/secret-box.ts";
import type { Database } from "../db/index.ts";
import { normalizeEmail } from "../members.ts";

export interface CompleteConnectionInput {
  /** 發起連接的個人帳號（Better Auth） */
  userId: string;
  userEmail: string;
  /** 已經用 validateClubName 檢查過 */
  clubName: string;
  /** 社團 Google 帳號，來自 readIdToken */
  googleEmail: string;
  /** 已經用 checkGrant 確認有值 */
  refreshToken: string;
  scopes: readonly string[];
}

export type CompleteConnectionResult =
  | { ok: true; clubId: string }
  | { ok: false; reason: "already_member" | "club_account_already_connected" };

const UNIQUE_VIOLATION = "23505";

/** 同時有人搶先一步時，資料庫唯一性規則擋下的是哪一條 */
export function reasonForUniqueViolation(
  error: unknown,
): "already_member" | "club_account_already_connected" | null {
  if (typeof error !== "object" || error === null) return null;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  if (code !== UNIQUE_VIOLATION) return null;
  if (constraint === "club_member_email_key") return "already_member";
  if (constraint === "club_connection_google_email_key") return "club_account_already_connected";
  return null;
}

/** 在已經開好的交易裡完成連接；呼叫端負責交易的開始與結束 */
export async function completeConnectionIn(
  trx: Transaction<Database>,
  input: CompleteConnectionInput,
  key: Buffer,
): Promise<CompleteConnectionResult> {
  const userEmail = normalizeEmail(input.userEmail);
  const googleEmail = normalizeEmail(input.googleEmail);

  const member = await trx.selectFrom("club_member").select("club_id").where("email", "=", userEmail).executeTakeFirst();
  if (member) return { ok: false, reason: "already_member" };

  const connection = await trx
    .selectFrom("club_connection")
    .select("club_id")
    .where("google_email", "=", googleEmail)
    .executeTakeFirst();
  if (connection) return { ok: false, reason: "club_account_already_connected" };

  const club = await trx.insertInto("club").values({ name: input.clubName }).returning("id").executeTakeFirstOrThrow();

  await trx
    .insertInto("club_connection")
    .values({
      club_id: club.id,
      google_email: googleEmail,
      // 綁定這個社團：密文搬到別的社團就解不開
      encrypted_refresh_token: encryptSecret(input.refreshToken, key, bindingFor("club_refresh_token", club.id)),
      scope: [...input.scopes].sort().join(" "),
      connected_by_user_id: input.userId,
      connected_by_email: userEmail,
    })
    .execute();

  await trx.insertInto("club_member").values({ club_id: club.id, email: userEmail, role: "pr_lead" }).execute();

  return { ok: true, clubId: club.id };
}

export async function completeConnection(
  db: Kysely<Database>,
  input: CompleteConnectionInput,
  key: Buffer,
): Promise<CompleteConnectionResult> {
  try {
    return await db.transaction().execute((trx) => completeConnectionIn(trx, input, key));
  } catch (error) {
    // 交易已經整個取消；如果是被別人搶先，回傳對應的「擋下」，其他錯誤照常拋出
    const reason = reasonForUniqueViolation(error);
    if (reason) return { ok: false, reason };
    throw error;
  }
}

/** 首頁「連接完成」訊息用：社團名稱和連接的社團 Google 帳號；沒有連接紀錄時回傳 null */
export async function connectedClubSummary(
  db: Kysely<Database>,
  clubId: string,
): Promise<{ name: string; googleEmail: string } | null> {
  const row = await db
    .selectFrom("club")
    .innerJoin("club_connection", "club_connection.club_id", "club.id")
    .select(["club.name", "club_connection.google_email"])
    .where("club.id", "=", clubId)
    .executeTakeFirst();
  return row ? { name: row.name, googleEmail: row.google_email } : null;
}

/**
 * 這個社團 Google 帳號是不是已經連接了某個社團。
 * 用來決定能不能撤銷剛拿到的 token：Google 撤銷是以「我們的 App＋那個帳號」為單位，
 * 已經連接的帳號一旦撤銷，原本那個社團存的 token 也會一起失效，所以只有沒連接過才撤銷。
 */
export async function isGoogleAccountConnected(db: Kysely<Database>, googleEmail: string): Promise<boolean> {
  const row = await db
    .selectFrom("club_connection")
    .select("club_id")
    .where("google_email", "=", normalizeEmail(googleEmail))
    .executeTakeFirst();
  return row !== undefined;
}
