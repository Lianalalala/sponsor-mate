// Google 個人登入（Better Auth 無資料庫模式）。只能在伺服器端 import。
// 這裡只拿 openid、email、profile，不碰 Gmail 或 Drive；
// 社團帳號的授權是另一段流程，不共用這裡的設定。
//
// 用函式延後建立：部署環境還沒設定變數時，網站仍要能 build 和開啟。

import { betterAuth } from "better-auth";

const REQUIRED_ENV = [
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
] as const;

export function isAuthConfigured(): boolean {
  return REQUIRED_ENV.every((name) => Boolean(process.env[name]));
}

function createAuth() {
  return betterAuth({
    appName: "Sponsor Mate",
    baseURL: process.env.BETTER_AUTH_URL,
    secret: process.env.BETTER_AUTH_SECRET,
    socialProviders: {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID as string,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
        prompt: "select_account",
      },
    },
    onAPIError: { errorURL: "/login?error=1" },
  });
}

let auth: ReturnType<typeof createAuth> | undefined;

export function getAuth(): ReturnType<typeof createAuth> {
  auth ??= createAuth();
  return auth;
}
