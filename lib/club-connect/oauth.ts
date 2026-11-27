// 「連接社團帳號」的 OAuth 工具（D-020、D-027）。只能在伺服器端 import。
//
// 跟個人登入（Better Auth）完全分開：
// - 個人登入只拿 openid、email、profile，token 存在 Better Auth 的 account 表
// - 社團連接拿 gmail.send＋drive.file（加 openid、email 用來知道是哪個社團帳號），
//   refresh token 加密後存在我們自己的 club_connection 表，不進 account 表
//
// 流程：
//   start：startAttempt → sealAttempt（加密放進 cookie）→ buildAuthorizationUrl（導去 Google）
//   callback：openAttempt（驗 cookie 和 state）→ exchangeCode → checkGrant → readIdToken
//
// 這個檔案不讀環境變數、不碰資料庫；所有對 Google 的請求都用傳進來的 fetcher，測試時換成假的。
// 錯誤訊息一律是固定文字，不包含 token、授權碼、state 或 Google 回應的內容。

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { bindingFor, decryptSecret, encryptSecret } from "../crypto/secret-box.ts";

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
/** 向 Google 要的權限。openid、email 是非敏感權限，只用來知道社團 Google 帳號的 email */
export const CLUB_SCOPES = ["openid", "email", GMAIL_SEND_SCOPE, DRIVE_FILE_SCOPE] as const;
/** 一定要拿到的權限；Google 允許使用者在授權畫面取消勾選，所以回來後要再檢查 */
const REQUIRED_SCOPES = [GMAIL_SEND_SCOPE, DRIVE_FILE_SCOPE] as const;

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

/** 連接中資料的 cookie 名稱與有效時間 */
export const ATTEMPT_COOKIE = "sm_club_connect";
export const ATTEMPT_TTL_MS = 10 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 15_000;

export type ClubConnectErrorCode =
  | "attempt_missing"
  | "attempt_invalid"
  | "attempt_expired"
  | "state_mismatch"
  | "user_mismatch"
  | "google_denied"
  | "invalid_callback"
  | "token_exchange_failed"
  | "invalid_token_response"
  | "missing_refresh_token"
  | "missing_scopes"
  | "invalid_id_token"
  | "email_not_verified";

const MESSAGES: Record<ClubConnectErrorCode, string> = {
  attempt_missing: "找不到這次連接的資料，可能已經過期，請從首頁重新開始連接",
  attempt_invalid: "這次連接的資料無效，請從首頁重新開始連接",
  attempt_expired: "連接逾時（超過 10 分鐘），請從首頁重新開始連接",
  state_mismatch: "連接的驗證碼不符，為了安全這次不完成連接，請從首頁重新開始",
  user_mismatch: "開始連接和完成連接的不是同一個登入帳號，請從首頁重新開始",
  google_denied: "沒有完成 Google 授權（可能按了取消），社團帳號沒有連接",
  invalid_callback: "Google 回傳的資料不完整，請從首頁重新開始連接",
  token_exchange_failed: "跟 Google 換取授權時失敗，請稍後再試",
  invalid_token_response: "Google 回傳的授權資料格式不正確，請稍後再試",
  missing_refresh_token: "Google 沒有給長期授權，請從首頁重新連接，並在授權畫面按「允許」",
  missing_scopes: "授權不完整：寄信（Gmail）和試算表（Google Drive）兩項權限都要勾選，請重新連接",
  invalid_id_token: "無法確認社團 Google 帳號，請稍後再試",
  email_not_verified: "這個 Google 帳號的 email 還沒驗證，請換一個已驗證的社團帳號",
};

/** 給畫面顯示用的固定訊息 */
export function clubConnectErrorMessage(code: ClubConnectErrorCode): string {
  return MESSAGES[code];
}

export class ClubConnectError extends Error {
  readonly code: ClubConnectErrorCode;

  constructor(code: ClubConnectErrorCode) {
    super(MESSAGES[code]);
    this.name = "ClubConnectError";
    this.code = code;
  }
}

// ───────────────────────── 開始連接 ─────────────────────────

/** 存在 cookie 裡的連接中資料（加密後才放進 cookie） */
export interface ConnectAttempt {
  /** 防 CSRF：Google 會原封不動帶回來，要跟這裡一致 */
  state: string;
  /** PKCE：換 token 時要附上，只有發起連接的伺服器知道 */
  codeVerifier: string;
  /** 發起連接的個人帳號（Better Auth 的 user id） */
  userId: string;
  /** 已經檢查過的社團名稱（lib/club-name.ts） */
  clubName: string;
  /** 毫秒時間戳記 */
  expiresAt: number;
}

const randomToken = (random: (size: number) => Buffer) => random(32).toString("base64url");

export function startAttempt(
  input: { userId: string; clubName: string; now: number },
  random: (size: number) => Buffer = randomBytes,
): { attempt: ConnectAttempt; codeChallenge: string } {
  const attempt: ConnectAttempt = {
    state: randomToken(random),
    codeVerifier: randomToken(random),
    userId: input.userId,
    clubName: input.clubName,
    expiresAt: input.now + ATTEMPT_TTL_MS,
  };
  const codeChallenge = createHash("sha256").update(attempt.codeVerifier).digest("base64url");
  return { attempt, codeChallenge };
}

/** 加密後放進 cookie；綁定發起者的 user id，別人的 cookie 拿來用也解不開 */
export function sealAttempt(attempt: ConnectAttempt, key: Buffer): string {
  return encryptSecret(JSON.stringify(attempt), key, bindingFor("club_connect_attempt", attempt.userId));
}

export function buildAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", CLUB_SCOPES.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // 少了這兩個，Google 不會給 refresh token
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent select_account");
  // 不要把這個瀏覽器之前給過的其他權限（例如個人登入）混進來
  url.searchParams.set("include_granted_scopes", "false");
  return url.toString();
}

// ───────────────────────── 完成連接（callback）─────────────────────────

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // 長度不同時 timingSafeEqual 會拋錯，先比長度
  return left.length === right.length && timingSafeEqual(left, right);
}

function isAttempt(value: unknown): value is ConnectAttempt {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.state === "string" && v.state !== "" &&
    typeof v.codeVerifier === "string" && v.codeVerifier !== "" &&
    typeof v.userId === "string" && v.userId !== "" &&
    typeof v.clubName === "string" && v.clubName !== "" &&
    typeof v.expiresAt === "number" && Number.isFinite(v.expiresAt)
  );
}

/**
 * 驗證 cookie 裡的連接中資料：解得開、是同一個人、沒過期、state 一致。
 * 任何一項不符都拋 ClubConnectError，呼叫端不能繼續換 token。
 */
export function openAttempt(
  cookieValue: string | undefined,
  check: { key: Buffer; userId: string; state: string | null; now: number },
): ConnectAttempt {
  if (!cookieValue) throw new ClubConnectError("attempt_missing");

  let attempt: unknown;
  try {
    // 綁定的是「目前登入的人」：換了人登入就解不開
    attempt = JSON.parse(decryptSecret(cookieValue, check.key, bindingFor("club_connect_attempt", check.userId)));
  } catch {
    throw new ClubConnectError("attempt_invalid");
  }
  if (!isAttempt(attempt)) throw new ClubConnectError("attempt_invalid");
  if (attempt.userId !== check.userId) throw new ClubConnectError("user_mismatch");
  if (check.now > attempt.expiresAt) throw new ClubConnectError("attempt_expired");
  if (!check.state || !sameText(check.state, attempt.state)) throw new ClubConnectError("state_mismatch");
  return attempt;
}

/** callback 網址上的參數：使用者按取消時 Google 會帶 error，正常時帶 code */
export function readCallbackParams(params: URLSearchParams): { code: string; state: string } {
  if (params.has("error")) throw new ClubConnectError("google_denied");
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state || code.length > 2048 || state.length > 512) throw new ClubConnectError("invalid_callback");
  return { code, state };
}

export interface GoogleTokens {
  accessToken: string;
  /** Google 有時不給（例如沒有 prompt=consent）；checkGrant 會擋下 */
  refreshToken: string | null;
  /** Google 實際給的權限 */
  scopes: string[];
  idToken: string | null;
}

async function postForm(fetcher: typeof fetch, url: string, form: Record<string, string>): Promise<Response> {
  return fetcher(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

export async function exchangeCode(
  input: { code: string; codeVerifier: string; clientId: string; clientSecret: string; redirectUri: string },
  fetcher: typeof fetch,
): Promise<GoogleTokens> {
  let response: Response;
  try {
    response = await postForm(fetcher, TOKEN_ENDPOINT, {
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.codeVerifier,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
    });
  } catch {
    throw new ClubConnectError("token_exchange_failed");
  }
  // 不讀 Google 的錯誤內容，避免裡面的細節跑進紀錄
  if (!response.ok) throw new ClubConnectError("token_exchange_failed");

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await response.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    throw new ClubConnectError("invalid_token_response");
  }

  const { access_token, refresh_token, scope, id_token } = body;
  if (typeof access_token !== "string" || access_token === "" || typeof scope !== "string") {
    throw new ClubConnectError("invalid_token_response");
  }
  return {
    accessToken: access_token,
    refreshToken: typeof refresh_token === "string" && refresh_token !== "" ? refresh_token : null,
    scopes: scope.split(" ").filter(Boolean),
    idToken: typeof id_token === "string" && id_token !== "" ? id_token : null,
  };
}

/** 檢查 Google 給的授權夠不夠用：要有 refresh token，也要有寄信和 Drive 兩項權限 */
export function checkGrant(tokens: GoogleTokens): asserts tokens is GoogleTokens & { refreshToken: string } {
  if (!REQUIRED_SCOPES.every((s) => tokens.scopes.includes(s))) throw new ClubConnectError("missing_scopes");
  if (!tokens.refreshToken) throw new ClubConnectError("missing_refresh_token");
}

/**
 * 從 id_token 讀出社團 Google 帳號的 email。
 * id_token 是我們的伺服器直接向 Google token 端點（HTTPS）拿到的，依 OpenID Connect 規範
 * 這種情況可以不驗簽章，但仍要檢查發行者、對象（我們的 client id）、有效期限與 email 已驗證。
 */
export function readIdToken(
  idToken: string | null,
  check: { clientId: string; now: number },
): { email: string; subject: string } {
  if (!idToken) throw new ClubConnectError("invalid_id_token");
  let claims: Record<string, unknown>;
  try {
    const parts = idToken.split(".");
    if (parts.length !== 3) throw new Error();
    const parsed: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    claims = parsed as Record<string, unknown>;
  } catch {
    throw new ClubConnectError("invalid_id_token");
  }

  const { iss, aud, exp, sub, email, email_verified } = claims;
  if (typeof iss !== "string" || !GOOGLE_ISSUERS.includes(iss)) throw new ClubConnectError("invalid_id_token");
  if (aud !== check.clientId) throw new ClubConnectError("invalid_id_token");
  if (typeof exp !== "number" || exp * 1000 <= check.now) throw new ClubConnectError("invalid_id_token");
  if (typeof sub !== "string" || sub === "") throw new ClubConnectError("invalid_id_token");
  if (typeof email !== "string" || !email.includes("@")) throw new ClubConnectError("invalid_id_token");
  if (email_verified !== true) throw new ClubConnectError("email_not_verified");
  return { email: email.trim().toLowerCase(), subject: sub };
}

// ───────────────────────── 用 refresh token 換 access token ─────────────────────────

/**
 * 換 access token 的結果。不拋錯，讓呼叫端依原因決定要不要清掉 token：
 * - revoked：Google 回 invalid_grant（社團撤銷授權、測試模式約 7 天到期、密碼變更等），refresh token 已經沒用
 * - missing_scopes：換到了，但寄信或 Drive 權限不見了
 * - temporary：網路、Google 5xx、格式不對等，refresh token 可能還有效，不能清掉
 */
export type RefreshResult =
  | { ok: true; accessToken: string; expiresInSeconds: number }
  | { ok: false; reason: "revoked" | "missing_scopes" | "temporary" };

export async function refreshAccessToken(
  input: { refreshToken: string; clientId: string; clientSecret: string },
  fetcher: typeof fetch,
): Promise<RefreshResult> {
  let response: Response;
  try {
    response = await postForm(fetcher, TOKEN_ENDPOINT, {
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      client_secret: input.clientSecret,
    });
  } catch {
    return { ok: false, reason: "temporary" };
  }

  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await response.json();
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    body = null;
  }

  if (!response.ok) {
    // 只看 error 這個代碼，不讀、不保留 Google 回應的其他內容
    if (response.status === 400 && body?.error === "invalid_grant") return { ok: false, reason: "revoked" };
    return { ok: false, reason: "temporary" };
  }
  if (!body) return { ok: false, reason: "temporary" };

  const { access_token, expires_in, scope } = body;
  if (typeof access_token !== "string" || access_token === "" || /[^\x21-\x7e]/u.test(access_token)) {
    return { ok: false, reason: "temporary" };
  }
  if (typeof expires_in !== "number" || !Number.isFinite(expires_in) || expires_in <= 0) {
    return { ok: false, reason: "temporary" };
  }
  // Google 換 token 時會回傳目前的權限；有給就檢查，沒給就沿用連接時已檢查過的結果
  if (scope !== undefined) {
    if (typeof scope !== "string") return { ok: false, reason: "temporary" };
    const scopes = scope.split(" ").filter(Boolean);
    if (!REQUIRED_SCOPES.every((s) => scopes.includes(s))) return { ok: false, reason: "missing_scopes" };
  }
  return { ok: true, accessToken: access_token, expiresInSeconds: expires_in };
}

/**
 * 撤銷剛拿到但不能用的授權（例如權限不完整），讓社團帳號不會留著一份沒用的授權。
 * 盡力而為：失敗只回傳 false，不拋錯，也不記錄 token。
 */
export async function revokeToken(token: string, fetcher: typeof fetch): Promise<boolean> {
  try {
    const response = await postForm(fetcher, REVOKE_ENDPOINT, { token });
    return response.ok;
  } catch {
    return false;
  }
}
