import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { roleForUser } from "../members.ts";

const env = { PR_LEAD_EMAILS: "Lead@Example.com, both@example.com", MEMBER_EMAILS: "m@example.com,both@example.com" };
const verified = (email: string) => ({ email, emailVerified: true });

describe("成員名單", () => {
  it("公關長和組員", () => {
    assert.equal(roleForUser(verified("lead@example.com"), env), "pr_lead");
    assert.equal(roleForUser(verified("m@example.com"), env), "member");
  });
  it("兩邊都有時以公關長為準", () => {
    assert.equal(roleForUser(verified("both@example.com"), env), "pr_lead");
  });
  it("Email 大小寫和空白不影響", () => {
    assert.equal(roleForUser(verified(" LEAD@example.COM "), env), "pr_lead");
  });
  it("名單外的 Google 帳號沒有權限", () => {
    assert.equal(roleForUser(verified("stranger@example.com"), env), null);
  });
  it("名單沒設定時所有人都沒有權限", () => {
    assert.equal(roleForUser(verified("lead@example.com"), {}), null);
  });
  it("Email 未驗證沒有權限", () => {
    assert.equal(roleForUser({ email: "lead@example.com", emailVerified: false }, env), null);
  });
});
