import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { importAccessFor, type CurrentUser } from "../current-member.ts";
import { roleForUser } from "../members.ts";
import { washingEndpoint } from "../washing/http.ts";

// 用和正式環境一樣的 roleForUser 決定角色，只是名單換成測試用的
const env = { PR_LEAD_EMAILS: "lead@example.com", MEMBER_EMAILS: "member@example.com" };

function userFor(email: string, emailVerified = true): CurrentUser {
  return { email, name: "測試", role: roleForUser({ email, emailVerified }, env) };
}

const LEAD = userFor("lead@example.com");
const MEMBER = userFor("member@example.com");
const STRANGER = userFor("stranger@example.com");
const UNVERIFIED_LEAD = userFor("lead@example.com", false);

/** 模擬一個清洗 API；handlerCalls 記錄 handler（讀檔、呼叫 AI 的地方）有沒有被執行 */
function fakeEndpoint(user: CurrentUser | null) {
  const state = { handlerCalls: 0 };
  const endpoint = washingEndpoint(
    async () => {
      state.handlerCalls += 1;
      return Response.json({ ok: true });
    },
    { checkAccess: async () => importAccessFor(user) },
  );
  const call = () => endpoint(new Request("http://localhost/api/import/analyze", { method: "POST" }));
  return { state, call };
}

describe("匯入舊資料的權限（importAccessFor）", () => {
  it("公關長可以使用", () => {
    assert.equal(importAccessFor(LEAD).allowed, true);
  });
  it("組員被擋下（403）", () => {
    assert.deepEqual(importAccessFor(MEMBER), { allowed: false, status: 403, reason: "not_pr_lead" });
  });
  it("名單外的 Google 帳號被擋下（403）", () => {
    assert.deepEqual(importAccessFor(STRANGER), { allowed: false, status: 403, reason: "not_pr_lead" });
  });
  it("Email 未驗證，就算在公關長名單裡也擋下", () => {
    assert.equal(importAccessFor(UNVERIFIED_LEAD).allowed, false);
  });
  it("沒登入被擋下（401）", () => {
    assert.deepEqual(importAccessFor(null), { allowed: false, status: 401, reason: "not_signed_in" });
  });
});

describe("清洗 API 的伺服器端檢查（washingEndpoint）", () => {
  it("公關長：執行清洗", async () => {
    const { state, call } = fakeEndpoint(LEAD);
    const response = await call();
    assert.equal(response.status, 200);
    assert.equal(state.handlerCalls, 1);
  });

  it("組員：回傳 403，而且完全沒有執行到讀檔與 AI", async () => {
    const { state, call } = fakeEndpoint(MEMBER);
    const response = await call();
    assert.equal(response.status, 403);
    assert.equal(state.handlerCalls, 0);
  });

  it("名單外：回傳 403，沒有執行", async () => {
    const { state, call } = fakeEndpoint(STRANGER);
    assert.equal((await call()).status, 403);
    assert.equal(state.handlerCalls, 0);
  });

  it("Email 未驗證：回傳 403，沒有執行", async () => {
    const { state, call } = fakeEndpoint(UNVERIFIED_LEAD);
    assert.equal((await call()).status, 403);
    assert.equal(state.handlerCalls, 0);
  });

  it("沒登入：回傳 401，沒有執行", async () => {
    const { state, call } = fakeEndpoint(null);
    assert.equal((await call()).status, 401);
    assert.equal(state.handlerCalls, 0);
  });

  it("本機工具：不是 localhost 時連權限都不看，直接 404", async () => {
    let checked = false;
    const endpoint = washingEndpoint(async () => Response.json({ ok: true }), {
      localOnly: true,
      checkAccess: async () => {
        checked = true;
        return importAccessFor(LEAD);
      },
    });
    const request = { headers: new Headers({ host: "192.168.1.5:3000" }) } as Request;
    assert.equal((await endpoint(request)).status, 404);
    assert.equal(checked, false);
  });
});
