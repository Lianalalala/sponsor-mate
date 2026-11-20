// 第 5a 步：連接社團帳號的 OAuth 工具。
// 用假的 Google（fakeGoogle）回應，不連網路；鑰匙、token、授權碼都是測試裡的假值。

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  ATTEMPT_TTL_MS,
  buildAuthorizationUrl,
  checkGrant,
  ClubConnectError,
  CLUB_SCOPES,
  DRIVE_FILE_SCOPE,
  exchangeCode,
  GMAIL_SEND_SCOPE,
  openAttempt,
  readCallbackParams,
  readIdToken,
  revokeToken,
  sealAttempt,
  startAttempt,
  type GoogleTokens,
} from "../club-connect/oauth.ts";
import { bindingFor, encryptSecret, parseKey } from "../crypto/secret-box.ts";

const KEY = parseKey(Buffer.alloc(32, 3).toString("base64"));
const OTHER_KEY = parseKey(Buffer.alloc(32, 4).toString("base64"));
const NOW = Date.UTC(2026, 10, 20, 8, 0, 0);
const USER = "user-liana";
const OTHER_USER = "user-someone-else";
const CLIENT_ID = "fake-client-id.apps.googleusercontent.com";
const CLIENT_SECRET = "fake-client-secret-DO-NOT-LOG";
const REDIRECT_URI = "http://localhost:3000/api/club/connect/callback";
const FAKE_CODE = "4/fake-authorization-code-DO-NOT-LOG";
const FAKE_ACCESS = "ya29.fake-access-token-DO-NOT-LOG";
const FAKE_REFRESH = "1//fake-refresh-token-DO-NOT-LOG";

function isError(code: ClubConnectError["code"]) {
  return (error: unknown) => error instanceof ClubConnectError && error.code === code;
}

function idToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256", typ: "JWT" })}.${part(claims)}.fake-signature`;
}

const GOOD_CLAIMS = {
  iss: "https://accounts.google.com",
  aud: CLIENT_ID,
  exp: NOW / 1000 + 3600,
  sub: "1234567890",
  email: "Club.Account@Gmail.com",
  email_verified: true,
};

/** 假的 Google：記錄收到的請求，回傳指定的結果 */
function fakeGoogle(reply: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return reply();
  }) as typeof fetch;
  return { fetcher, calls };
}

const tokenResponse = (overrides: Record<string, unknown> = {}) =>
  Response.json({
    access_token: FAKE_ACCESS,
    refresh_token: FAKE_REFRESH,
    scope: `openid ${GMAIL_SEND_SCOPE} ${DRIVE_FILE_SCOPE} https://www.googleapis.com/auth/userinfo.email`,
    id_token: idToken(GOOD_CLAIMS),
    expires_in: 3599,
    token_type: "Bearer",
    ...overrides,
  });

function newAttempt(overrides: { userId?: string; now?: number } = {}) {
  return startAttempt({ userId: overrides.userId ?? USER, clubName: "台大熱舞社", now: overrides.now ?? NOW });
}

// ───────────────────────── 開始連接 ─────────────────────────

describe("開始連接（startAttempt）", () => {
  it("state 和 PKCE 驗證碼是夠長的隨機值，每次都不同", () => {
    const a = newAttempt().attempt;
    const b = newAttempt().attempt;
    assert.notEqual(a.state, b.state);
    assert.notEqual(a.codeVerifier, b.codeVerifier);
    assert.equal(a.state.length, 43);
    // PKCE 規範：驗證碼 43–128 字
    assert.ok(a.codeVerifier.length >= 43 && a.codeVerifier.length <= 128);
  });

  it("code_challenge 是驗證碼的 SHA-256（S256）", () => {
    const { attempt, codeChallenge } = newAttempt();
    assert.equal(codeChallenge, createHash("sha256").update(attempt.codeVerifier).digest("base64url"));
  });

  it("10 分鐘後過期", () => {
    assert.equal(newAttempt().attempt.expiresAt, NOW + ATTEMPT_TTL_MS);
  });
});

describe("Google 授權網址（buildAuthorizationUrl）", () => {
  const { attempt, codeChallenge } = newAttempt();
  const url = new URL(
    buildAuthorizationUrl({ clientId: CLIENT_ID, redirectUri: REDIRECT_URI, state: attempt.state, codeChallenge }),
  );
  const p = url.searchParams;

  it("導去 Google 的授權頁", () => {
    assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  });

  it("要的權限剛好是 openid、email、gmail.send、drive.file，沒有讀信或整個 Drive", () => {
    assert.deepEqual(p.get("scope")?.split(" "), [...CLUB_SCOPES]);
    assert.doesNotMatch(p.get("scope") ?? "", /gmail\.readonly|gmail\.modify|gmail\.compose|auth\/drive(\s|$)|spreadsheets/);
  });

  it("要求 refresh token（offline＋consent），並讓使用者選社團帳號", () => {
    assert.equal(p.get("access_type"), "offline");
    assert.equal(p.get("prompt"), "consent select_account");
  });

  it("帶上 state、PKCE（S256），不混入其他已授權的權限", () => {
    assert.equal(p.get("state"), attempt.state);
    assert.equal(p.get("code_challenge"), codeChallenge);
    assert.equal(p.get("code_challenge_method"), "S256");
    assert.equal(p.get("include_granted_scopes"), "false");
    assert.equal(p.get("response_type"), "code");
    assert.equal(p.get("redirect_uri"), REDIRECT_URI);
  });

  it("網址裡沒有 PKCE 驗證碼本身、也沒有 client secret", () => {
    assert.equal(url.toString().includes(attempt.codeVerifier), false);
    assert.equal(url.toString().includes(CLIENT_SECRET), false);
  });
});

// ───────────────────────── cookie 裡的連接中資料 ─────────────────────────

describe("驗證連接中資料（sealAttempt → openAttempt）", () => {
  const { attempt } = newAttempt();
  const cookie = sealAttempt(attempt, KEY);
  const check = { key: KEY, userId: USER, state: attempt.state, now: NOW + 60_000 };

  it("cookie 是加密的：看不到 state、驗證碼或社團名稱", () => {
    for (const secret of [attempt.state, attempt.codeVerifier, attempt.clubName, USER]) {
      assert.equal(cookie.includes(secret), false);
    }
  });

  it("同一個人、沒過期、state 一致 → 通過，拿回原本的資料", () => {
    assert.deepEqual(openAttempt(cookie, check), attempt);
  });

  it("沒有 cookie", () => {
    assert.throws(() => openAttempt(undefined, check), isError("attempt_missing"));
    assert.throws(() => openAttempt("", check), isError("attempt_missing"));
  });

  it("換了人登入（別人的 cookie 帶到這個帳號）→ 解不開", () => {
    assert.throws(() => openAttempt(cookie, { ...check, userId: OTHER_USER }), isError("attempt_invalid"));
  });

  it("cookie 被改過、或用別的鑰匙", () => {
    const parts = cookie.split(":");
    parts[2] = parts[2].slice(0, -2) + (parts[2].endsWith("AA") ? "BB" : "AA");
    assert.throws(() => openAttempt(parts.join(":"), check), isError("attempt_invalid"));
    assert.throws(() => openAttempt(cookie, { ...check, key: OTHER_KEY }), isError("attempt_invalid"));
  });

  it("超過 10 分鐘", () => {
    assert.throws(() => openAttempt(cookie, { ...check, now: NOW + ATTEMPT_TTL_MS + 1 }), isError("attempt_expired"));
  });

  it("state 不一致、沒有 state、只差一個字", () => {
    assert.throws(() => openAttempt(cookie, { ...check, state: "something-else" }), isError("state_mismatch"));
    assert.throws(() => openAttempt(cookie, { ...check, state: null }), isError("state_mismatch"));
    const oneOff = attempt.state.slice(0, -1) + (attempt.state.endsWith("A") ? "B" : "A");
    assert.throws(() => openAttempt(cookie, { ...check, state: oneOff }), isError("state_mismatch"));
  });

  it("cookie 裡記的發起人跟目前登入的人不同 → 擋下（就算解得開）", () => {
    // 模擬：用 USER 的綁定加密，但內容寫成別人（正常流程不會發生，多一層保險）
    const forged = encryptSecret(
      JSON.stringify({ ...attempt, userId: OTHER_USER }),
      KEY,
      bindingFor("club_connect_attempt", USER),
    );
    assert.throws(() => openAttempt(forged, check), isError("user_mismatch"));
  });
});

describe("callback 網址參數（readCallbackParams）", () => {
  it("正常：拿到 code 和 state", () => {
    assert.deepEqual(readCallbackParams(new URLSearchParams({ code: FAKE_CODE, state: "s" })), {
      code: FAKE_CODE,
      state: "s",
    });
  });
  it("使用者在 Google 按取消", () => {
    assert.throws(() => readCallbackParams(new URLSearchParams({ error: "access_denied" })), isError("google_denied"));
  });
  it("缺 code 或 state、或長得不合理", () => {
    assert.throws(() => readCallbackParams(new URLSearchParams({ state: "s" })), isError("invalid_callback"));
    assert.throws(() => readCallbackParams(new URLSearchParams({ code: FAKE_CODE })), isError("invalid_callback"));
    assert.throws(
      () => readCallbackParams(new URLSearchParams({ code: "x".repeat(3000), state: "s" })),
      isError("invalid_callback"),
    );
  });
});

// ───────────────────────── 跟 Google 換 token ─────────────────────────

describe("用授權碼換 token（exchangeCode）", () => {
  const input = {
    code: FAKE_CODE,
    codeVerifier: "fake-verifier",
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
  };

  it("送到 Google token 端點，帶上授權碼、PKCE 驗證碼、redirect URI", async () => {
    const google = fakeGoogle(() => tokenResponse());
    const tokens = await exchangeCode(input, google.fetcher);

    assert.equal(google.calls.length, 1);
    const { url, init } = google.calls[0];
    assert.equal(url, "https://oauth2.googleapis.com/token");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    const form = new URLSearchParams(String(init.body));
    assert.equal(form.get("grant_type"), "authorization_code");
    assert.equal(form.get("code"), FAKE_CODE);
    assert.equal(form.get("code_verifier"), "fake-verifier");
    assert.equal(form.get("redirect_uri"), REDIRECT_URI);

    assert.equal(tokens.accessToken, FAKE_ACCESS);
    assert.equal(tokens.refreshToken, FAKE_REFRESH);
    assert.ok(tokens.scopes.includes(GMAIL_SEND_SCOPE));
  });

  it("Google 回錯誤（例如授權碼已用過）", async () => {
    const google = fakeGoogle(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
    await assert.rejects(exchangeCode(input, google.fetcher), isError("token_exchange_failed"));
  });

  it("連不上 Google", async () => {
    const google = fakeGoogle(() => {
      throw new TypeError("fetch failed");
    });
    await assert.rejects(exchangeCode(input, google.fetcher), isError("token_exchange_failed"));
  });

  it("回應不是 JSON、或缺 access_token／scope", async () => {
    for (const reply of [
      () => new Response("<html>oops</html>"),
      () => tokenResponse({ access_token: undefined }),
      () => tokenResponse({ scope: undefined }),
      () => Response.json(["not", "an", "object"]),
    ]) {
      await assert.rejects(exchangeCode(input, fakeGoogle(reply).fetcher), isError("invalid_token_response"));
    }
  });

  it("沒有 refresh token 時記成 null（交給 checkGrant 擋）", async () => {
    const tokens = await exchangeCode(input, fakeGoogle(() => tokenResponse({ refresh_token: undefined })).fetcher);
    assert.equal(tokens.refreshToken, null);
  });
});

describe("檢查授權夠不夠用（checkGrant）", () => {
  const full: GoogleTokens = {
    accessToken: FAKE_ACCESS,
    refreshToken: FAKE_REFRESH,
    scopes: ["openid", GMAIL_SEND_SCOPE, DRIVE_FILE_SCOPE],
    idToken: null,
  };

  it("兩項權限都有、也有 refresh token → 通過", () => {
    assert.doesNotThrow(() => checkGrant(full));
  });

  it("使用者取消勾選寄信或 Drive", () => {
    assert.throws(() => checkGrant({ ...full, scopes: ["openid", DRIVE_FILE_SCOPE] }), isError("missing_scopes"));
    assert.throws(() => checkGrant({ ...full, scopes: ["openid", GMAIL_SEND_SCOPE] }), isError("missing_scopes"));
  });

  it("沒有 refresh token", () => {
    assert.throws(() => checkGrant({ ...full, refreshToken: null }), isError("missing_refresh_token"));
  });
});

describe("讀社團帳號 email（readIdToken）", () => {
  const check = { clientId: CLIENT_ID, now: NOW };

  it("正常：email 轉小寫", () => {
    assert.deepEqual(readIdToken(idToken(GOOD_CLAIMS), check), { email: "club.account@gmail.com", subject: "1234567890" });
  });

  it("發行者也接受不帶 https:// 的寫法", () => {
    assert.equal(readIdToken(idToken({ ...GOOD_CLAIMS, iss: "accounts.google.com" }), check).subject, "1234567890");
  });

  it("不是 Google 發的、不是發給我們的、已過期、缺資料 → 擋下", () => {
    for (const claims of [
      { ...GOOD_CLAIMS, iss: "https://evil.example.com" },
      { ...GOOD_CLAIMS, aud: "someone-else.apps.googleusercontent.com" },
      { ...GOOD_CLAIMS, exp: NOW / 1000 - 1 },
      { ...GOOD_CLAIMS, sub: undefined },
      { ...GOOD_CLAIMS, email: undefined },
      { ...GOOD_CLAIMS, email: "not-an-email" },
    ]) {
      assert.throws(() => readIdToken(idToken(claims), check), isError("invalid_id_token"));
    }
  });

  it("沒有 id_token、或格式壞掉", () => {
    for (const bad of [null, "", "a.b", "a.%%%.c", `x.${Buffer.from("[]").toString("base64url")}.y`]) {
      assert.throws(() => readIdToken(bad, check), isError("invalid_id_token"));
    }
  });

  it("email 沒驗證過", () => {
    for (const value of [false, "true", undefined]) {
      assert.throws(
        () => readIdToken(idToken({ ...GOOD_CLAIMS, email_verified: value }), check),
        isError("email_not_verified"),
      );
    }
  });
});

describe("撤銷不能用的授權（revokeToken）", () => {
  it("送到 Google 撤銷端點", async () => {
    const google = fakeGoogle(() => new Response(null, { status: 200 }));
    assert.equal(await revokeToken(FAKE_REFRESH, google.fetcher), true);
    assert.equal(google.calls[0].url, "https://oauth2.googleapis.com/revoke");
    assert.equal(new URLSearchParams(String(google.calls[0].init.body)).get("token"), FAKE_REFRESH);
  });

  it("失敗只回 false，不拋錯", async () => {
    assert.equal(await revokeToken(FAKE_REFRESH, fakeGoogle(() => new Response(null, { status: 400 })).fetcher), false);
    assert.equal(
      await revokeToken(FAKE_REFRESH, fakeGoogle(() => { throw new TypeError("fetch failed"); }).fetcher),
      false,
    );
  });
});

// ───────────────────────── 不洩漏機密 ─────────────────────────

describe("錯誤訊息不洩漏機密", () => {
  it("各種失敗的錯誤裡都沒有 token、授權碼、client secret 或 Google 回應內容", async () => {
    const leaky = "SECRET-FROM-GOOGLE-BODY";
    const errors: unknown[] = [];
    const input = { code: FAKE_CODE, codeVerifier: "v", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI };
    const attempts: (() => unknown)[] = [
      () => exchangeCode(input, fakeGoogle(() => Response.json({ error: leaky }, { status: 400 })).fetcher),
      () => exchangeCode(input, fakeGoogle(() => new Response(leaky)).fetcher),
      () => exchangeCode(input, fakeGoogle(() => { throw new Error(leaky); }).fetcher),
      () => checkGrant({ accessToken: FAKE_ACCESS, refreshToken: FAKE_REFRESH, scopes: [], idToken: null }),
      () => readIdToken(idToken({ ...GOOD_CLAIMS, aud: leaky }), { clientId: CLIENT_ID, now: NOW }),
    ];
    for (const attempt of attempts) {
      try {
        await attempt();
      } catch (error) {
        errors.push(error);
      }
    }
    assert.equal(errors.length, attempts.length);
    for (const error of errors) {
      assert.ok(error instanceof ClubConnectError);
      const text = `${String(error)} ${JSON.stringify(error)} ${error.stack ?? ""}`;
      for (const secret of [leaky, FAKE_CODE, FAKE_ACCESS, FAKE_REFRESH, CLIENT_SECRET]) {
        assert.equal(text.includes(secret), false, `錯誤裡出現了 ${secret}`);
      }
      assert.equal(error.cause, undefined);
    }
  });
});
