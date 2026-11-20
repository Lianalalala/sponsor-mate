// 系統運作資料的資料庫連線（Neon Postgres，D-021、D-026）。只能在伺服器端 import。
// 社團業務資料（廠商、活動、往來紀錄）不在這裡，那些存在社團自己的 Google Drive（D-013）。
//
// 整個系統共用一個連線池：Better Auth（lib/auth.ts）和我們自己的表都從 getDb() 拿。
// 用函式延後建立：還沒設定 DATABASE_URL 時，網站仍要能 build 和開啟。

import { Kysely, PostgresDialect, type ColumnType, type Generated } from "kysely";
import pg from "pg";

import type { MemberRole } from "../members.ts";

type Env = Record<string, string | undefined>;

/** 有預設值、新增時可以不填的時間欄位 */
type CreatedAt = ColumnType<Date, Date | undefined, Date>;

/**
 * 我們自己的表，結構定義在 lib/db/migrations.ts。
 * Better Auth 的表（user、session、account、verification）由 Better Auth 自己管理，不列在這裡。
 */
export interface Database {
  club: {
    id: Generated<string>;
    name: string;
    /** 社團 Drive 裡的資料庫試算表；還沒建立前是 null */
    spreadsheet_id: string | null;
    created_at: CreatedAt;
  };
  club_member: {
    id: Generated<string>;
    club_id: string;
    /** 一律小寫；整張表唯一（一人只屬於一個社團） */
    email: string;
    role: MemberRole;
    invited_by_email: string | null;
    created_at: CreatedAt;
  };
  club_connection: {
    /** 主鍵：一個社團一列 */
    club_id: string;
    /** 一律小寫；一個社團 Google 帳號只能連一個社團 */
    google_email: string;
    /** lib/crypto 加密後的字串，不是明文；授權失效時為 null（見 connectionState） */
    encrypted_refresh_token: string | null;
    scope: string;
    connected_by_user_id: string;
    connected_by_email: string;
    connected_at: CreatedAt;
    /** 最後一次成功換到 access token；還沒換過是 null */
    last_refreshed_at: Date | null;
    /** 發現授權失效的時間；null 代表目前有效 */
    revoked_at: Date | null;
  };
}

export type ConnectionState = "active" | "revoked" | "invalid";

/**
 * 社團連接目前的狀態，跟資料庫檢查 club_connection_token_state 同一套規則：
 * 有 token、沒有撤銷時間＝有效；沒有 token、有撤銷時間＝失效；其他組合不合法。
 * 程式要用 token 前先看這裡，資料庫則保證不會存進不合法的組合。
 */
export function connectionState(row: {
  encrypted_refresh_token: string | null;
  revoked_at: Date | null;
}): ConnectionState {
  const token = row.encrypted_refresh_token;
  if (token === "") return "invalid";
  const hasToken = token !== null;
  const revoked = row.revoked_at !== null;
  if (hasToken && !revoked) return "active";
  if (!hasToken && revoked) return "revoked";
  return "invalid";
}

export function isDatabaseConfigured(env: Env = process.env): boolean {
  return Boolean(env.DATABASE_URL?.trim());
}

/** 建立連線池。pg 在第一次查詢時才真的連線，所以建立本身不會連到資料庫。 */
export function createDb(connectionString: string): Kysely<Database> {
  const pool = new pg.Pool({
    connectionString,
    // Vercel 的每個 serverless function 各自有連線池，數量要小，避免佔滿 Neon 的連線數
    max: 5,
    idleTimeoutMillis: 10_000,
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

let db: Kysely<Database> | undefined;

export function getDb(): Kysely<Database> {
  if (!isDatabaseConfigured()) {
    // 錯誤訊息只說缺什麼，不包含任何連線資訊
    throw new Error("資料庫還沒設定（缺 DATABASE_URL）");
  }
  db ??= createDb(process.env.DATABASE_URL as string);
  return db;
}
