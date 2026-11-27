// 第 5c 步：「連接社團帳號」兩個網址的完整流程（handleStart → Google → handleCallback）。
// 登入資訊、資料庫、Google 全部用假的；鑰匙、token、授權碼都是測試裡的假值。

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CompleteConnectionInput, CompleteConnectionResult } from "../club-connect/complete.ts";
import { handleCallback, handleStart, type ConnectDeps, type SessionUser } from "../club-connect/flow.ts";
import { connectNotice } from "../club-connect/messages.ts";
import { ATTEMPT_TTL_MS, DRIVE_FILE_SCOPE, GMAIL_SEND_SCOPE } from "../club-connect/oauth.ts";
import { parseKey } from "../crypto/secret-box.ts";
import type { Membership } from "../members.ts";

const BASE = "http://localhost:3000";
const KEY = parseKey(Buffer.alloc(32, 6).toString("base64"));
const CLIENT_ID = "fake-client-id.apps.googleusercontent.com";
const NOW = Date.UTC(2026, 10, 20, 9, 0, 0);
const FAKE_CODE = "4/fake-code-DO-NOT-LEAK";
const FAKE_ACCESS = "ya29.fake-access-DO-NOT-LEAK";
const FAKE_REFRESH = "1//fake-refresh-DO-NOT-LEAK";
const LIANA: SessionUser = { id: "user-liana", email: "Liana@Example.com", emailVerified: true };
const SOMEONE_ELSE: SessionUser = { id: "user-other", email: "other@example.com", emailVerified: true };

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const idToken = (claims: Record<string, unknown> = {}) =>
  `${part({ alg: "RS256" })}.${part({
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    exp: NOW / 1000 + 3600,
    sub: "club-sub",
    email: "Club.Account@Gmail.com",
    email_verified: true,
    ...claims,
  })}.sig`;

interface Options {
  user?: SessionUser | null;
  membership?: Membership | null;
  completeResult?: CompleteConnectionResult | Error;
  accountConnected?: boolean | Error;
  tokenBody?: Record<string, unknown>;
  baseUrl?: string;
  now?: number;
}

function makeDeps(options: Options = {}) {
  const calls = {
    complete: [] as CompleteConnectionInput[],
    tokenRequests: 0,
    revoked: [] as string[],
    membershipLookups: 0,
  };
  const deps: ConnectDeps = {
    config: { clientId: CLIENT_ID, clientSecret: "fake-secret", baseUrl: options.baseUrl ?? BASE, key: KEY },
    getSessionUser: async () => (options.user === undefined ? LIANA : options.user),
    findMembership: async () => {
      calls.membershipLookups++;
      return options.membership ?? null;
    },
    complete: async (input) => {
      calls.complete.push(input);
      const result = options.completeResult ?? { ok: true, clubId: "club-new" };
      if (result instanceof Error) throw result;
      return result;
    },
    isGoogleAccountConnected: async () => {
      const value = options.accountConnected ?? false;
      if (value instanceof Error) throw value;
      return value;
    },
    fetcher: (async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      if (target === "https://oauth2.googleapis.com/token") {
        calls.tokenRequests++;
        return Response.json({
          access_token: FAKE_ACCESS,
          refresh_token: FAKE_REFRESH,
          scope: `openid ${GMAIL_SEND_SCOPE} ${DRIVE_FILE_SCOPE}`,
          id_token: idToken(),
          ...options.tokenBody,
        });
      }
      if (target === "https://oauth2.googleapis.com/revoke") {
        calls.revoked.push(new URLSearchParams(String(init?.body)).get("token") ?? "");
        return new Response(null, { status: 200 });
      }
      throw new Error(`沒預期的請求：${target}`);
    }) as typeof fetch,
    now: () => options.now ?? NOW,
  };
  return { deps, calls };
}

function startRequest(fields: Record<string, string>, headers: Record<string, string> = { origin: BASE }) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return new Request(`${BASE}/api/club/connect/start`, { method: "POST", body, headers });
}

const location = (response: Response) => new URL(response.headers.get("location") ?? "", BASE);
const setCookie = (response: Response) => response.headers.get("set-cookie") ?? "";
const errorOf = (response: Response) => location(response).searchParams.get("connect_error");

/** 走完 start，回傳要帶去 callback 的 cookie 和 state */
async function begin(deps: ConnectDeps, clubName = "台大熱舞社") {
  const response = await handleStart(startRequest({ clubName }), deps);
  const cookie = setCookie(response).split(";")[0];
  const state = location(response).searchParams.get("state") ?? "";
  return { response, cookie, state };
}

function callbackRequest(query: Record<string, string>, cookie?: string) {
  const url = new URL("/api/club/connect/callback", BASE);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new Request(url, { headers: cookie ? { cookie } : {} });
}

// ───────────────────────── 開始連接 ─────────────────────────

describe("開始連接（POST /api/club/connect/start）", () => {
  it("成功：導去 Google，設定加密的 cookie（HttpOnly、SameSite=Lax、10 分鐘、只給 /api/club/connect）", async () => {
    const { deps } = makeDeps();
    const { response } = await begin(deps);
    assert.equal(response.status, 303);
    assert.equal(location(response).origin, "https://accounts.google.com");
    const cookie = setCookie(response);
    assert.match(cookie, /^sm_club_connect=v1:/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, new RegExp(`Max-Age=${ATTEMPT_TTL_MS / 1000}`));
    assert.match(cookie, /Path=\/api\/club\/connect(;|$)/);
    // cookie 裡看不到社團名稱
    assert.equal(cookie.includes(encodeURIComponent("台大熱舞社")) || cookie.includes("台大熱舞社"), false);
  });

  it("本機（http）不加 Secure；正式網址（https）一定加 Secure", async () => {
    assert.doesNotMatch(setCookie((await begin(makeDeps().deps)).response), /Secure/);
    const https = makeDeps({ baseUrl: "https://sponsor-mate.vercel.app" }).deps;
    const response = await handleStart(startRequest({ clubName: "社" }, { origin: "https://sponsor-mate.vercel.app" }), https);
    assert.match(setCookie(response), /Secure/);
  });

  it("redirect URI 用設定的網址組，不採用請求帶來的 Host", async () => {
    const { deps } = makeDeps();
    const request = startRequest({ clubName: "社" }, { origin: BASE, host: "evil.example.com" });
    const redirectUri = location(await handleStart(request, deps)).searchParams.get("redirect_uri");
    assert.equal(redirectUri, `${BASE}/api/club/connect/callback`);
  });

  it("別的網站送來的表單（Origin 不同）→ 擋下，不設 cookie", async () => {
    const { deps } = makeDeps();
    const response = await handleStart(startRequest({ clubName: "社" }, { origin: "https://evil.example.com" }), deps);
    assert.equal(errorOf(response), "bad_request");
    assert.equal(setCookie(response), "");
  });

  it("沒有 Origin 時看 Sec-Fetch-Site：same-origin 可以，cross-site 擋下", async () => {
    const ok = await handleStart(startRequest({ clubName: "社" }, { "sec-fetch-site": "same-origin" }), makeDeps().deps);
    assert.equal(location(ok).origin, "https://accounts.google.com");
    const bad = await handleStart(startRequest({ clubName: "社" }, { "sec-fetch-site": "cross-site" }), makeDeps().deps);
    assert.equal(errorOf(bad), "bad_request");
  });

  it("沒登入 → 導去登入頁", async () => {
    const response = await handleStart(startRequest({ clubName: "社" }), makeDeps({ user: null }).deps);
    assert.equal(location(response).pathname, "/login");
    assert.equal(setCookie(response), "");
  });

  it("個人帳號 email 沒驗證 → 擋下", async () => {
    const { deps } = makeDeps({ user: { ...LIANA, emailVerified: false } });
    assert.equal(errorOf(await handleStart(startRequest({ clubName: "社" }), deps)), "email_not_verified_personal");
  });

  it("已經是某個社團的成員 → 擋下（一人一社團），不導去 Google", async () => {
    const { deps } = makeDeps({ membership: { clubId: "club-dev", role: "pr_lead" } });
    const response = await handleStart(startRequest({ clubName: "社" }), deps);
    assert.equal(errorOf(response), "already_member");
    assert.equal(setCookie(response), "");
  });

  it("社團名稱空的、太長、有隱形字元、沒填 → 擋下", async () => {
    const cases: Record<string, string>[] = [{ clubName: "  " }, { clubName: "社".repeat(51) }, { clubName: "熱舞\u200b社" }, {}];
    for (const fields of cases) {
      const response = await handleStart(startRequest(fields), makeDeps().deps);
      assert.equal(errorOf(response), "invalid_club_name");
    }
  });
});

// ───────────────────────── 完成連接 ─────────────────────────

describe("完成連接（GET /api/club/connect/callback）", () => {
  it("成功：寫進資料庫（社團名稱來自 cookie、社團 email 轉小寫），回首頁顯示成功，清掉 cookie", async () => {
    const { deps, calls } = makeDeps();
    const { cookie, state } = await begin(deps);
    const response = await handleCallback(callbackRequest({ code: FAKE_CODE, state }, cookie), deps);

    assert.equal(location(response).searchParams.get("connect"), "ok");
    assert.match(setCookie(response), /^sm_club_connect=; .*Max-Age=0/);
    assert.deepEqual(calls.complete, [
      {
        userId: "user-liana",
        userEmail: "Liana@Example.com",
        clubName: "台大熱舞社",
        googleEmail: "club.account@gmail.com",
        refreshToken: FAKE_REFRESH,
        scopes: ["openid", GMAIL_SEND_SCOPE, DRIVE_FILE_SCOPE],
      },
    ]);
    assert.deepEqual(calls.revoked, []);
  });

  it("沒登入 → 導去登入頁，清掉 cookie，不跟 Google 換 token", async () => {
    const { deps, calls } = makeDeps();
    const { cookie, state } = await begin(deps);
    const loggedOut = makeDeps({ user: null });
    const response = await handleCallback(callbackRequest({ code: FAKE_CODE, state }, cookie), loggedOut.deps);
    assert.equal(location(response).pathname, "/login");
    assert.match(setCookie(response), /Max-Age=0/);
    assert.equal(calls.tokenRequests + loggedOut.calls.tokenRequests, 0);
  });

  it("換了人登入 → 解不開 cookie，不換 token", async () => {
    const { deps } = makeDeps();
    const { cookie, state } = await begin(deps);
    const other = makeDeps({ user: SOMEONE_ELSE });
    const response = await handleCallback(callbackRequest({ code: FAKE_CODE, state }, cookie), other.deps);
    assert.equal(errorOf(response), "attempt_invalid");
    assert.equal(other.calls.tokenRequests, 0);
  });

  it("state 不對、沒有 cookie、超過 10 分鐘 → 擋下，不換 token", async () => {
    const { deps, calls } = makeDeps();
    const { cookie, state } = await begin(deps);

    assert.equal(errorOf(await handleCallback(callbackRequest({ code: FAKE_CODE, state: "wrong" }, cookie), deps)), "state_mismatch");
    assert.equal(errorOf(await handleCallback(callbackRequest({ code: FAKE_CODE, state }), deps)), "attempt_missing");
    const late = makeDeps({ now: NOW + ATTEMPT_TTL_MS + 1 });
    assert.equal(errorOf(await handleCallback(callbackRequest({ code: FAKE_CODE, state }, cookie), late.deps)), "attempt_expired");
    assert.equal(calls.tokenRequests + late.calls.tokenRequests, 0);
  });

  it("使用者在 Google 按取消 → 顯示沒有完成授權", async () => {
    const { deps, calls } = makeDeps();
    const { cookie, state } = await begin(deps);
    const response = await handleCallback(callbackRequest({ error: "access_denied", state }, cookie), deps);
    assert.equal(errorOf(response), "google_denied");
    assert.equal(calls.tokenRequests, 0);
  });

  it("權限沒勾齊 → 不寫資料庫；這個社團帳號沒連過，所以撤銷授權", async () => {
    const { deps, calls } = makeDeps({ tokenBody: { scope: `openid ${DRIVE_FILE_SCOPE}` } });
    const { cookie, state } = await begin(deps);
    const response = await handleCallback(callbackRequest({ code: FAKE_CODE, state }, cookie), deps);
    assert.equal(errorOf(response), "missing_scopes");
    assert.deepEqual(calls.complete, []);
    assert.deepEqual(calls.revoked, [FAKE_REFRESH]);
  });

  it("權限沒勾齊，但這個社團帳號已經連接了某個社團 → 不撤銷（避免弄壞那個社團）", async () => {
    const { deps, calls } = makeDeps({ tokenBody: { scope: "openid" }, accountConnected: true });
    const { cookie, state } = await begin(deps);
    assert.equal(errorOf(await handleCallback(callbackRequest({ code: FAKE_CODE, state }, cookie), deps)), "missing_scopes");
    assert.deepEqual(calls.revoked, []);
  });

  it("社團帳號已經連接過（重新連接未定案）→ 擋下，不撤銷", async () => {
    const { deps, calls } = makeDeps({
      completeResult: { ok: false, reason: "club_account_already_connected" },
      accountConnected: true,
    });
    const { cookie, state } = await begin(deps);
    assert.equal(
      errorOf(await handleCallback(callbackRequest({ code: FAKE_CODE, state }, cookie), deps)),
      "club_account_already_connected",
    );
    assert.deepEqual(calls.revoked, []);
  });

  it("連接中途發起人被加進別的社團 → 擋下；社團帳號沒連過，所以撤銷", async () => {
    const { deps, calls } = makeDeps({ completeResult: { ok: false, reason: "already_member" } });
    const { cookie, state } = await begin(deps);
    assert.equal(errorOf(await handleCallback(callbackRequest({ code: FAKE_CODE, state }, cookie), deps)), "already_member");
    assert.deepEqual(calls.revoked, [FAKE_REFRESH]);
  });

  it("沒有 refresh token → 擋下，用 access token 撤銷", async () => {
    const { deps, calls } = makeDeps({ tokenBody: { refresh_token: undefined } });
    const { cookie, state } = await begin(deps);
    assert.equal(
      errorOf(await handleCallback(callbackRequest({ code: FAKE_CODE, state }, cookie), deps)),
      "missing_refresh_token",
    );
    assert.deepEqual(calls.revoked, [FAKE_ACCESS]);
  });

  it("id_token 不對 → 不知道是哪個社團帳號，所以不撤銷", async () => {
    const { deps, calls } = makeDeps({ tokenBody: { id_token: idToken({ aud: "someone-else" }) } });
    const { cookie, state } = await begin(deps);
    assert.equal(errorOf(await handleCallback(callbackRequest({ code: FAKE_CODE, state }, cookie), deps)), "invalid_id_token");
    assert.deepEqual(calls.revoked, []);
  });

  it("寫資料庫時出錯、而且查不到社團帳號有沒有連過 → 顯示錯誤，不撤銷", async () => {
    const { deps, calls } = makeDeps({ completeResult: new Error("db down"), accountConnected: new Error("db down") });
    const { cookie, state } = await begin(deps);
    const original = console.error;
    console.error = () => {};
    try {
      assert.equal(errorOf(await handleCallback(callbackRequest({ code: FAKE_CODE, state }, cookie), deps)), "unexpected");
    } finally {
      console.error = original;
    }
    assert.deepEqual(calls.revoked, []);
  });

  it("同一份 cookie 不能用第二次：每次 callback 都會清掉", async () => {
    const { deps } = makeDeps();
    const { cookie, state } = await begin(deps);
    const queries: Record<string, string>[] = [{ code: FAKE_CODE, state }, { code: FAKE_CODE, state: "wrong" }, { error: "access_denied" }];
    for (const query of queries) {
      assert.match(setCookie(await handleCallback(callbackRequest(query, cookie), deps)), /Max-Age=0/);
    }
  });

  it("導回首頁的網址不含 token、授權碼或 email", async () => {
    for (const options of [{}, { tokenBody: { scope: "openid" } }, { completeResult: { ok: false, reason: "already_member" } as const }]) {
      const { deps } = makeDeps(options);
      const { cookie, state } = await begin(deps);
      const target = (await handleCallback(callbackRequest({ code: FAKE_CODE, state }, cookie), deps)).headers.get("location") ?? "";
      for (const secret of [FAKE_CODE, FAKE_ACCESS, FAKE_REFRESH, "club.account", "liana"]) {
        assert.equal(target.toLowerCase().includes(secret.toLowerCase()), false, `網址出現 ${secret}`);
      }
    }
  });
});

// ───────────────────────── 首頁訊息 ─────────────────────────

describe("首頁的連接結果訊息（connectNotice）", () => {
  it("成功：顯示社團名稱和社團 Google 帳號", () => {
    assert.deepEqual(connectNotice({ connect: "ok" }, { name: "台大熱舞社", googleEmail: "club@gmail.com" }), {
      kind: "success",
      message: "社團帳號連接完成，你現在是台大熱舞社（club@gmail.com）的公關長。",
    });
  });

  it("成功但查不到社團 → 通用訊息", () => {
    assert.deepEqual(connectNotice({ connect: "ok" }), {
      kind: "success",
      message: "社團帳號連接完成，你現在是這個社團的公關長。",
    });
  });

  it("認得的錯誤代碼 → 固定訊息", () => {
    assert.match(connectNotice({ connect_error: "already_member" })?.message ?? "", /一個人只能屬於一個社團/);
    assert.match(connectNotice({ connect_error: "missing_scopes" })?.message ?? "", /權限都要勾選/);
  });

  it("不認得的代碼、網址被改成奇怪的內容 → 什麼都不顯示", () => {
    for (const code of ["<script>alert(1)</script>", "toString", "__proto__", "", "constructor"]) {
      assert.equal(connectNotice({ connect_error: code }), null);
    }
    assert.equal(connectNotice({ connect_error: ["already_member", "x"] }), null);
    assert.equal(connectNotice({}), null);
  });
});
