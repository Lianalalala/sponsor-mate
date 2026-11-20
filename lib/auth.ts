// Google 個人登入（Better Auth＋Neon Postgres，D-017、D-021、D-026）。只能在伺服器端 import。
// 這裡只拿 openid、email、profile，不碰 Gmail 或 Drive；
// 社團帳號的授權是另一段流程（D-020、D-027），不共用這裡的設定，token 也不存進 Better Auth 的 account 表。
//
// 用函式延後建立：部署環境還沒設定變數時，網站仍要能 build 和開啟。

import { betterAuth, type BetterAuthOptions } from "better-auth";
import type { Kysely } from "kysely";

import { getDb } from "./db/index.ts";

type Env = Record<string, string | undefined>;

const REQUIRED_ENV = [
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "DATABASE_URL",
] as const;

export function isAuthConfigured(env: Env = process.env): boolean {
  return REQUIRED_ENV.every((name) => Boolean(env[name]?.trim()));
}

/**
 * Better Auth 的設定。正式執行（getAuth）和建表腳本（scripts/db-migrate.ts）共用同一份，
 * 確保建出來的表跟程式實際用的一致。
 */
export function buildAuthOptions<DB>(db: Kysely<DB>, env: Env = process.env) {
  return {
    appName: "Sponsor Mate",
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    // 跟我們自己的表共用同一個 Kysely 連線池（D-026）
    database: { db, type: "postgres" },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID as string,
        clientSecret: env.GOOGLE_CLIENT_SECRET as string,
        prompt: "select_account",
        // 不設定 scope：只用 Better Auth 預設的 openid、email、profile
      },
    },
    onAPIError: { errorURL: "/login?error=1" },
  } satisfies BetterAuthOptions;
}

function createAuth() {
  return betterAuth(buildAuthOptions(getDb()));
}

let auth: ReturnType<typeof createAuth> | undefined;

export function getAuth(): ReturnType<typeof createAuth> {
  auth ??= createAuth();
  return auth;
}
