// 「連接社團帳號」的兩個網址要做的事（D-020、D-027）。只能在伺服器端 import。
//
//   POST /api/club/connect/start     首頁表單送出社團名稱 → 檢查 → 設 cookie → 導去 Google
//   GET  /api/club/connect/callback  Google 帶回授權碼 → 驗證 → 換 token → 寫進資料庫 → 回首頁
//
// 用到的外部東西（登入資訊、資料庫、Google、時間）都由 ConnectDeps 傳進來，
// 正式環境在 lib/club-connect/deps.ts 組好；測試時換成假的，就能把每條路徑都跑一遍。
//
// 結果一律導回首頁，用 ?connect=ok 或 ?connect_error=<代碼> 告訴首頁要顯示哪段固定訊息；
// 網址上不會出現 token、授權碼、email 或錯誤細節。紀錄（console）只記錯誤代碼。

import { validateClubName } from "../club-name.ts";
import type { Membership } from "../members.ts";
import type { CompleteConnectionInput, CompleteConnectionResult } from "./complete.ts";
import {
  ATTEMPT_COOKIE,
  ATTEMPT_TTL_MS,
  buildAuthorizationUrl,
  checkGrant,
  ClubConnectError,
  exchangeCode,
  openAttempt,
  readCallbackParams,
  readIdToken,
  revokeToken,
  sealAttempt,
  startAttempt,
  type ClubConnectErrorCode,
  type ConnectAttempt,
  type GoogleTokens,
} from "./oauth.ts";

export const CALLBACK_PATH = "/api/club/connect/callback";
const COOKIE_PATH = "/api/club/connect";

export interface ClubConnectConfig {
  clientId: string;
  clientSecret: string;
  /** 網站的正式網址（BETTER_AUTH_URL），用來組 redirect URI，不採用請求帶來的 Host */
  baseUrl: string;
  /** TOKEN_ENCRYPTION_KEY */
  key: Buffer;
}

export interface SessionUser {
  id: string;
  email: string;
  emailVerified: boolean;
}

export interface ConnectDeps {
  config: ClubConnectConfig;
  getSessionUser(headers: Headers): Promise<SessionUser | null>;
  findMembership(user: SessionUser): Promise<Membership | null>;
  complete(input: CompleteConnectionInput): Promise<CompleteConnectionResult>;
  isGoogleAccountConnected(googleEmail: string): Promise<boolean>;
  fetcher: typeof fetch;
  now(): number;
  random?: (size: number) => Buffer;
}

/** 首頁顯示訊息用的代碼（不是 ClubConnectError 的那些另外列在這裡） */
export type ConnectResultCode =
  | ClubConnectErrorCode
  | "not_configured"
  | "not_signed_in"
  | "email_not_verified_personal"
  | "already_member"
  | "club_account_already_connected"
  | "invalid_club_name"
  | "bad_request"
  | "unexpected";

// ───────────────────────── 回應 ─────────────────────────

function cookieHeader(value: string, maxAgeSeconds: number, secure: boolean): string {
  return [
    `${ATTEMPT_COOKIE}=${value}`,
    `Path=${COOKIE_PATH}`,
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    // Google 導回 callback 是一般的頁面跳轉（GET），Lax 會帶上 cookie；別的網站用 POST 偷送則不會
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function redirect(location: string, setCookie?: string): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  if (setCookie) headers.append("Set-Cookie", setCookie);
  return new Response(null, { status: 303, headers });
}

function home(config: ClubConnectConfig, result: { ok: true } | { error: ConnectResultCode }): string {
  const url = new URL("/", config.baseUrl);
  if ("ok" in result) url.searchParams.set("connect", "ok");
  else url.searchParams.set("connect_error", result.error);
  return url.toString();
}

const isSecure = (config: ClubConnectConfig) => config.baseUrl.startsWith("https://");
const clearCookie = (config: ClubConnectConfig) => cookieHeader("", 0, isSecure(config));

function readCookie(headers: Headers, name: string): string | undefined {
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

/** 表單一定要從我們自己的網站送出（擋下別的網站偷偷替使用者發起連接） */
function isSameOrigin(request: Request, config: ClubConnectConfig): boolean {
  const origin = request.headers.get("origin");
  if (origin) return origin === new URL(config.baseUrl).origin;
  return request.headers.get("sec-fetch-site") === "same-origin";
}

// ───────────────────────── 開始連接 ─────────────────────────

export async function handleStart(request: Request, deps: ConnectDeps): Promise<Response> {
  const { config } = deps;
  const fail = (error: ConnectResultCode) => redirect(home(config, { error }));

  if (!isSameOrigin(request, config)) return fail("bad_request");

  const user = await deps.getSessionUser(request.headers);
  if (!user) return redirect(new URL("/login", config.baseUrl).toString());
  // 個人帳號 email 沒驗證過，就沒辦法對應成員名單，也不能成為公關長
  if (!user.emailVerified) return fail("email_not_verified_personal");
  // 一人只屬於一個社團：已經在某個社團的人不能再連接新社團
  if (await deps.findMembership(user)) return fail("already_member");

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail("bad_request");
  }
  const name = validateClubName(form.get("clubName"));
  if (!name.ok) return fail("invalid_club_name");

  const { attempt, codeChallenge } = startAttempt({ userId: user.id, clubName: name.name, now: deps.now() }, deps.random);
  const googleUrl = buildAuthorizationUrl({
    clientId: config.clientId,
    redirectUri: new URL(CALLBACK_PATH, config.baseUrl).toString(),
    state: attempt.state,
    codeChallenge,
  });
  return redirect(googleUrl, cookieHeader(sealAttempt(attempt, config.key), ATTEMPT_TTL_MS / 1000, isSecure(config)));
}

// ───────────────────────── 完成連接（callback）─────────────────────────

/**
 * 拿到 token 之後卻不能用時，決定要不要在 Google 撤銷。
 * 只有「確定知道是哪個社團帳號，而且它沒有連接任何社團」才撤銷：
 * Google 撤銷是以「我們的 App＋那個帳號」為單位，已連接的帳號一撤銷，原本社團的 token 也會失效。
 */
async function revokeIfSafe(tokens: GoogleTokens, googleEmail: string | null, deps: ConnectDeps): Promise<void> {
  if (!googleEmail) return;
  try {
    if (await deps.isGoogleAccountConnected(googleEmail)) return;
  } catch {
    return; // 查不到就當作不安全，不撤銷
  }
  await revokeToken(tokens.refreshToken ?? tokens.accessToken, deps.fetcher);
}

export async function handleCallback(request: Request, deps: ConnectDeps): Promise<Response> {
  const { config } = deps;
  // 不論結果如何，「連接中」的 cookie 都要清掉，同一份不能用第二次
  const done = (result: { ok: true } | { error: ConnectResultCode }) =>
    redirect(home(config, result), clearCookie(config));

  const user = await deps.getSessionUser(request.headers);
  if (!user) return redirect(new URL("/login", config.baseUrl).toString(), clearCookie(config));

  let tokens: GoogleTokens;
  let attempt: ConnectAttempt;
  try {
    const params = readCallbackParams(new URL(request.url).searchParams);
    attempt = openAttempt(readCookie(request.headers, ATTEMPT_COOKIE), {
      key: config.key,
      userId: user.id,
      state: params.state,
      now: deps.now(),
    });
    tokens = await exchangeCode(
      {
        code: params.code,
        codeVerifier: attempt.codeVerifier,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectUri: new URL(CALLBACK_PATH, config.baseUrl).toString(),
      },
      deps.fetcher,
    );
  } catch (error) {
    // 還沒拿到 token（或換 token 失敗），沒有東西要撤銷
    return done({ error: error instanceof ClubConnectError ? error.code : "unexpected" });
  }

  // 從這裡開始已經拿到 token；不能用的話要考慮撤銷
  let googleEmail: string | null = null;
  try {
    googleEmail = readIdToken(tokens.idToken, { clientId: config.clientId, now: deps.now() }).email;
    checkGrant(tokens);

    const result = await deps.complete({
      userId: user.id,
      userEmail: user.email,
      clubName: attempt.clubName,
      googleEmail,
      refreshToken: tokens.refreshToken,
      scopes: tokens.scopes,
    });
    if (result.ok) return done({ ok: true });

    // 擋下：重新連接（未定案）或發起人已屬於其他社團
    await revokeIfSafe(tokens, googleEmail, deps);
    return done({ error: result.reason });
  } catch (error) {
    await revokeIfSafe(tokens, googleEmail, deps);
    if (error instanceof ClubConnectError) return done({ error: error.code });
    console.error("club-connect: 未預期的錯誤", error instanceof Error ? error.name : "unknown");
    return done({ error: "unexpected" });
  }
}
