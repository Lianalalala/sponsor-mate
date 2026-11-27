// getAccessToken：用社團的 refresh token 換 access token、失效偵測、記憶體暫存。
// 用假的 Google 和假的資料庫，不連網路、不連線；鑰匙和 token 都是測試裡的假值。

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ClubTokenError,
  createClubTokenProvider,
  dbClubTokenStore,
  REFRESH_MARGIN_MS,
  type ClubTokenStore,
  type StoredConnection,
} from "../club-connect/access-token.ts";
import { DRIVE_FILE_SCOPE, GMAIL_SEND_SCOPE, refreshAccessToken } from "../club-connect/oauth.ts";
import { bindingFor, encryptSecret, parseKey } from "../crypto/secret-box.ts";
import { createFakeDb } from "./helpers/fake-db.ts";

const KEY = parseKey(Buffer.alloc(32, 7).toString("base64"));
const OTHER_KEY = parseKey(Buffer.alloc(32, 8).toString("base64"));
const CLUB = "33333333-3333-4333-8333-333333333333";
const OTHER_CLUB = "44444444-4444-4444-8444-444444444444";
const REFRESH = "1//fake-refresh-token";
const ACCESS = "ya29.fake-access-token";
const CLIENT = { clientId: "client-id.apps.googleusercontent.com", clientSecret: "fake-client-secret" };
const NOW = Date.UTC(2026, 10, 27, 8, 0, 0);
const FULL_SCOPE = ["openid", "email", GMAIL_SEND_SCOPE, DRIVE_FILE_SCOPE].join(" ");

const sealed = (clubId = CLUB, key = KEY) => encryptSecret(REFRESH, key, bindingFor("club_refresh_token", clubId));

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** 假的 Google：依序回傳設定好的回應，並記錄收到的表單 */
function fakeGoogle(...responses: (Response | Error)[]) {
  const forms: URLSearchParams[] = [];
  const urls: string[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    forms.push(new URLSearchParams(String(init?.body ?? "")));
    const next = responses.shift();
    if (!next) throw new Error("假的 Google 沒有更多回應");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetcher, forms, urls };
}

const ok = (expiresIn = 3599, scope: string | undefined = FULL_SCOPE) =>
  json(200, { access_token: ACCESS, expires_in: expiresIn, token_type: "Bearer", ...(scope ? { scope } : {}) });

/** 假的資料庫：記錄 markRefreshed／markRevoked 的呼叫 */
function fakeStore(initial: StoredConnection | null = { encryptedRefreshToken: sealed(), revokedAt: null }) {
  let row = initial;
  const calls = { read: 0, refreshed: [] as Date[], revoked: [] as { token: string; at: Date }[] };
  const store: ClubTokenStore = {
    async read(clubId) {
      calls.read++;
      return clubId === CLUB ? row : null;
    },
    async markRefreshed(_clubId, at) {
      calls.refreshed.push(at);
    },
    async markRevoked(_clubId, token, at) {
      calls.revoked.push({ token, at });
      if (row?.encryptedRefreshToken !== token) return false;
      row = { encryptedRefreshToken: null, revokedAt: at };
      return true;
    },
  };
  return { store, calls, current: () => row };
}

function setup(options: { store?: ReturnType<typeof fakeStore>; google: ReturnType<typeof fakeGoogle>; key?: Buffer }) {
  let now = NOW;
  const store = options.store ?? fakeStore();
  const provider = createClubTokenProvider({
    store: store.store,
    key: options.key ?? KEY,
    ...CLIENT,
    fetcher: options.google.fetcher,
    now: () => now,
  });
  return { provider, store, advance: (ms: number) => (now += ms) };
}

async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ClubTokenError);
    assert.equal(error.code, code);
    return true;
  });
}

describe("refreshAccessToken：向 Google 換 access token", () => {
  it("送出 refresh_token 授權，拿到 access token 和有效秒數", async () => {
    const google = fakeGoogle(ok());
    const result = await refreshAccessToken({ refreshToken: REFRESH, ...CLIENT }, google.fetcher);
    assert.deepEqual(result, { ok: true, accessToken: ACCESS, expiresInSeconds: 3599 });
    assert.equal(google.urls[0], "https://oauth2.googleapis.com/token");
    assert.equal(google.forms[0].get("grant_type"), "refresh_token");
    assert.equal(google.forms[0].get("refresh_token"), REFRESH);
    assert.equal(google.forms[0].get("client_id"), CLIENT.clientId);
  });

  it("Google 沒回傳 scope 時，沿用連接時檢查過的結果", async () => {
    const result = await refreshAccessToken({ refreshToken: REFRESH, ...CLIENT }, fakeGoogle(ok(3599, undefined)).fetcher);
    assert.equal(result.ok, true);
  });

  it("400 invalid_grant → revoked", async () => {
    const google = fakeGoogle(json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }));
    assert.deepEqual(await refreshAccessToken({ refreshToken: REFRESH, ...CLIENT }, google.fetcher), {
      ok: false,
      reason: "revoked",
    });
  });

  it("其他錯誤都算暫時錯誤：invalid_client、5xx、斷線、格式不對", async () => {
    const cases: (Response | Error)[] = [
      json(401, { error: "invalid_client" }),
      json(400, { error: "invalid_request" }),
      json(503, { error: "backend_error" }),
      new Response("not json", { status: 500 }),
      new TypeError("fetch failed"),
      json(200, { expires_in: 3599 }),
      json(200, { access_token: ACCESS, expires_in: "3599" }),
      json(200, { access_token: ACCESS, expires_in: 0 }),
      json(200, { access_token: "ya29.has space", expires_in: 3599 }),
      json(200, [ACCESS]),
    ];
    for (const response of cases) {
      const result = await refreshAccessToken({ refreshToken: REFRESH, ...CLIENT }, fakeGoogle(response).fetcher);
      assert.deepEqual(result, { ok: false, reason: "temporary" });
    }
  });

  it("權限少了寄信或 Drive → missing_scopes", async () => {
    for (const scope of [`openid email ${GMAIL_SEND_SCOPE}`, `openid email ${DRIVE_FILE_SCOPE}`]) {
      const result = await refreshAccessToken({ refreshToken: REFRESH, ...CLIENT }, fakeGoogle(ok(3599, scope)).fetcher);
      assert.deepEqual(result, { ok: false, reason: "missing_scopes" });
    }
  });
});

describe("getAccessToken：成功", () => {
  it("解密 refresh token、換到 access token、更新 last_refreshed_at", async () => {
    const google = fakeGoogle(ok());
    const { provider, store } = setup({ google });
    assert.equal(await provider.getAccessToken(CLUB), ACCESS);
    assert.equal(google.forms[0].get("refresh_token"), REFRESH);
    assert.deepEqual(store.calls.refreshed, [new Date(NOW)]);
    assert.equal(store.calls.revoked.length, 0);
  });

  it("記錄 last_refreshed_at 失敗不影響拿到的 token", async () => {
    const store = fakeStore();
    store.store.markRefreshed = async () => {
      throw new Error("資料庫暫時連不上");
    };
    const { provider } = setup({ store, google: fakeGoogle(ok()) });
    assert.equal(await provider.getAccessToken(CLUB), ACCESS);
  });
});

describe("getAccessToken：記憶體暫存", () => {
  it("有效期間內不再向 Google 換", async () => {
    const google = fakeGoogle(ok(3600));
    const { provider, store, advance } = setup({ google });
    await provider.getAccessToken(CLUB);
    advance(3600 * 1000 - REFRESH_MARGIN_MS - 1);
    assert.equal(await provider.getAccessToken(CLUB), ACCESS);
    assert.equal(google.urls.length, 1);
    assert.equal(store.calls.read, 1);
  });

  it("到期前 5 分鐘就重新換", async () => {
    const google = fakeGoogle(ok(3600), ok(3600));
    const { provider, advance } = setup({ google });
    await provider.getAccessToken(CLUB);
    advance(3600 * 1000 - REFRESH_MARGIN_MS);
    await provider.getAccessToken(CLUB);
    assert.equal(google.urls.length, 2);
  });

  it("有效期太短（5 分鐘內）就不暫存", async () => {
    const google = fakeGoogle(ok(120), ok(120));
    const { provider } = setup({ google });
    await provider.getAccessToken(CLUB);
    await provider.getAccessToken(CLUB);
    assert.equal(google.urls.length, 2);
  });

  it("forget 之後下次會重新換", async () => {
    const google = fakeGoogle(ok(), ok());
    const { provider } = setup({ google });
    await provider.getAccessToken(CLUB);
    provider.forget(CLUB);
    await provider.getAccessToken(CLUB);
    assert.equal(google.urls.length, 2);
  });

  it("同時好幾個請求只向 Google 換一次", async () => {
    const google = fakeGoogle(ok());
    const { provider } = setup({ google });
    const tokens = await Promise.all([1, 2, 3].map(() => provider.getAccessToken(CLUB)));
    assert.deepEqual(tokens, [ACCESS, ACCESS, ACCESS]);
    assert.equal(google.urls.length, 1);
  });

  it("失敗不暫存：下次會再試", async () => {
    const google = fakeGoogle(json(503, {}), ok());
    const { provider } = setup({ google });
    await rejectsWith(provider.getAccessToken(CLUB), "temporary_failure");
    assert.equal(await provider.getAccessToken(CLUB), ACCESS);
  });
});

describe("getAccessToken：失效偵測", () => {
  it("Google 回 invalid_grant → 清掉 token、填 revoked_at，回報要重新連接", async () => {
    const store = fakeStore();
    const original = store.current()?.encryptedRefreshToken;
    const { provider } = setup({ store, google: fakeGoogle(json(400, { error: "invalid_grant" })) });
    await rejectsWith(provider.getAccessToken(CLUB), "revoked");
    assert.deepEqual(store.calls.revoked, [{ token: original, at: new Date(NOW) }]);
    assert.deepEqual(store.current(), { encryptedRefreshToken: null, revokedAt: new Date(NOW) });
    assert.equal(store.calls.refreshed.length, 0);
  });

  it("已經失效的社團不會再向 Google 換", async () => {
    const google = fakeGoogle();
    const store = fakeStore({ encryptedRefreshToken: null, revokedAt: new Date(NOW - 1000) });
    const { provider } = setup({ store, google });
    await rejectsWith(provider.getAccessToken(CLUB), "revoked");
    assert.equal(google.urls.length, 0);
  });

  it("暫時錯誤（5xx、斷線）不清 token", async () => {
    for (const response of [json(500, {}), new TypeError("fetch failed")]) {
      const store = fakeStore();
      const { provider } = setup({ store, google: fakeGoogle(response) });
      await rejectsWith(provider.getAccessToken(CLUB), "temporary_failure");
      assert.equal(store.calls.revoked.length, 0);
      assert.notEqual(store.current()?.encryptedRefreshToken, null);
    }
  });

  it("權限不完整 → missing_scopes，不清 token", async () => {
    const store = fakeStore();
    const { provider } = setup({ store, google: fakeGoogle(ok(3599, `openid ${GMAIL_SEND_SCOPE}`)) });
    await rejectsWith(provider.getAccessToken(CLUB), "missing_scopes");
    assert.equal(store.calls.revoked.length, 0);
  });
});

describe("getAccessToken：資料不對時擋下", () => {
  it("沒有這個社團的連接 → not_connected，不呼叫 Google", async () => {
    const google = fakeGoogle();
    const { provider } = setup({ google });
    await rejectsWith(provider.getAccessToken(OTHER_CLUB), "not_connected");
    await rejectsWith(provider.getAccessToken(""), "not_connected");
    assert.equal(google.urls.length, 0);
  });

  it("鑰匙不對 → decrypt_failed，不清 token、不呼叫 Google", async () => {
    const google = fakeGoogle();
    const store = fakeStore();
    const { provider } = setup({ store, google, key: OTHER_KEY });
    await rejectsWith(provider.getAccessToken(CLUB), "decrypt_failed");
    assert.equal(google.urls.length, 0);
    assert.equal(store.calls.revoked.length, 0);
  });

  it("密文是別的社團的 → decrypt_failed（綁定社團ID）", async () => {
    const store = fakeStore({ encryptedRefreshToken: sealed(OTHER_CLUB), revokedAt: null });
    const { provider } = setup({ store, google: fakeGoogle() });
    await rejectsWith(provider.getAccessToken(CLUB), "decrypt_failed");
  });

  it("不合法的狀態組合 → invalid_state", async () => {
    const bad: StoredConnection[] = [
      { encryptedRefreshToken: sealed(), revokedAt: new Date(NOW) },
      { encryptedRefreshToken: null, revokedAt: null },
      { encryptedRefreshToken: "", revokedAt: null },
    ];
    for (const row of bad) {
      const { provider } = setup({ store: fakeStore(row), google: fakeGoogle() });
      await rejectsWith(provider.getAccessToken(CLUB), "invalid_state");
    }
  });
});

describe("錯誤訊息不外洩機密", () => {
  it("各種失敗的錯誤訊息都不含 refresh token、access token、client secret", async () => {
    const cases = [
      fakeGoogle(json(400, { error: "invalid_grant", error_description: REFRESH })),
      fakeGoogle(json(500, { error: CLIENT.clientSecret })),
      fakeGoogle(ok(3599, "openid")),
      fakeGoogle(new TypeError(`fetch failed ${REFRESH}`)),
    ];
    for (const google of cases) {
      const { provider } = setup({ google });
      const error = await provider.getAccessToken(CLUB).catch((e: unknown) => e);
      assert.ok(error instanceof ClubTokenError);
      const text = `${error.message} ${error.stack ?? ""} ${JSON.stringify(error)}`;
      for (const secret of [REFRESH, ACCESS, CLIENT.clientSecret]) assert.ok(!text.includes(secret));
    }
  });
});

describe("dbClubTokenStore：送出的查詢", () => {
  it("讀取：只查這個社團", async () => {
    const token = sealed();
    const { db, queries } = createFakeDb(() => [{ encrypted_refresh_token: token, revoked_at: null }]);
    assert.deepEqual(await dbClubTokenStore(db).read(CLUB), { encryptedRefreshToken: token, revokedAt: null });
    assert.match(queries[0].sql, /from "club_connection" where "club_id" = \$1/);
    assert.deepEqual(queries[0].parameters, [CLUB]);
  });

  it("讀取：沒有這一列回傳 null", async () => {
    const { db } = createFakeDb(() => []);
    assert.equal(await dbClubTokenStore(db).read(CLUB), null);
  });

  it("更新 last_refreshed_at：只改還沒失效的", async () => {
    const { db, queries } = createFakeDb();
    await dbClubTokenStore(db).markRefreshed(CLUB, new Date(NOW));
    assert.match(queries[0].sql, /update "club_connection" set "last_refreshed_at" = \$1 where "club_id" = \$2 and "revoked_at" is null/);
    assert.deepEqual(queries[0].parameters, [new Date(NOW), CLUB]);
  });

  it("標記失效：清 token、填 revoked_at，只在 token 還是剛剛讀到的那一個時才改", async () => {
    const token = sealed();
    const { db, queries } = createFakeDb();
    await dbClubTokenStore(db).markRevoked(CLUB, token, new Date(NOW));
    assert.match(
      queries[0].sql,
      /update "club_connection" set "encrypted_refresh_token" = \$1, "revoked_at" = \$2 where "club_id" = \$3 and "encrypted_refresh_token" = \$4/,
    );
    assert.deepEqual(queries[0].parameters, [null, new Date(NOW), CLUB, token]);
  });
});
