// 社團連接的狀態判斷（connectionState），跟資料庫檢查 club_connection_token_state 同一套規則。
// 資料庫真的會不會拒絕，用 npm run db:check 在 dev branch 實際測（這裡不連資料庫）。

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { connectionState } from "../db/index.ts";

const TOKEN = "v1:fake-iv:fake-ciphertext:fake-tag";
const REVOKED_AT = new Date("2026-11-27T00:00:00Z");

describe("社團連接的狀態（connectionState）", () => {
  it("有效：有 token、沒有撤銷時間", () => {
    assert.equal(connectionState({ encrypted_refresh_token: TOKEN, revoked_at: null }), "active");
  });

  it("失效：沒有 token、有撤銷時間", () => {
    assert.equal(connectionState({ encrypted_refresh_token: null, revoked_at: REVOKED_AT }), "revoked");
  });

  it("不合法：有 token 又有撤銷時間（失效了卻沒清掉 token）", () => {
    assert.equal(connectionState({ encrypted_refresh_token: TOKEN, revoked_at: REVOKED_AT }), "invalid");
  });

  it("不合法：沒有 token 也沒有撤銷時間（不知道為什麼沒 token）", () => {
    assert.equal(connectionState({ encrypted_refresh_token: null, revoked_at: null }), "invalid");
  });

  it("不合法：token 是空字串，不能當成有效", () => {
    assert.equal(connectionState({ encrypted_refresh_token: "", revoked_at: null }), "invalid");
    assert.equal(connectionState({ encrypted_refresh_token: "", revoked_at: REVOKED_AT }), "invalid");
  });
});
