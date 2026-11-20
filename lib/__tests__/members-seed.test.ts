// 從環境變數搬名單進資料庫的規劃（planSeed）。只算出要做什麼，不連資料庫。

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { maskEmail, parseEmailList, planSeed } from "../members-seed.ts";

const CLUB = "11111111-1111-4111-8111-111111111111";
const OTHER_CLUB = "22222222-2222-4222-8222-222222222222";

describe("讀環境變數的 email 清單（parseEmailList）", () => {
  it("逗號分隔、去空白、轉小寫、去重複、略過空的", () => {
    assert.deepEqual(parseEmailList(" A@x.com, b@x.com ,,a@X.COM, "), ["a@x.com", "b@x.com"]);
  });
  it("沒設定就是空清單", () => {
    assert.deepEqual(parseEmailList(undefined), []);
  });
});

describe("搬進資料庫的規劃（planSeed）", () => {
  const env = { PR_LEAD_EMAILS: "Lead@x.com, both@x.com", MEMBER_EMAILS: "m@x.com, both@x.com" };

  it("資料庫是空的：全部新增；兩邊都有的人以公關長為準", () => {
    const plan = planSeed(env, null, []);
    assert.deepEqual(
      [...plan.add].sort((a, b) => a.email.localeCompare(b.email)),
      [
        { email: "both@x.com", role: "pr_lead" },
        { email: "lead@x.com", role: "pr_lead" },
        { email: "m@x.com", role: "member" },
      ],
    );
    assert.deepEqual(plan.skip, []);
  });

  it("已經在這個社團、角色一樣：跳過（可以重複跑）", () => {
    const plan = planSeed(env, CLUB, [{ email: "lead@x.com", clubId: CLUB, role: "pr_lead" }]);
    assert.equal(plan.add.some((a) => a.email === "lead@x.com"), false);
    assert.deepEqual(plan.skip, [{ email: "lead@x.com", reason: "已在名單裡" }]);
  });

  it("已經在這個社團、角色不同：跳過，不自動改角色", () => {
    const plan = planSeed(env, CLUB, [{ email: "m@x.com", clubId: CLUB, role: "pr_lead" }]);
    assert.deepEqual(plan.skip, [{ email: "m@x.com", reason: "已在名單裡但角色不同，不自動更改" }]);
  });

  it("已經屬於其他社團：跳過（一人只屬於一個社團）", () => {
    const plan = planSeed(env, CLUB, [{ email: "lead@x.com", clubId: OTHER_CLUB, role: "member" }]);
    assert.deepEqual(plan.skip, [{ email: "lead@x.com", reason: "已經屬於其他社團（一人只屬於一個社團）" }]);
  });

  it("測試社團還沒建立時，資料庫裡已有的人都算其他社團", () => {
    const plan = planSeed(env, null, [{ email: "m@x.com", clubId: OTHER_CLUB, role: "member" }]);
    assert.equal(plan.skip[0].reason, "已經屬於其他社團（一人只屬於一個社團）");
  });

  it("環境變數都沒設定：什麼都不做", () => {
    assert.deepEqual(planSeed({}, null, []), { add: [], skip: [] });
  });
});

describe("終端機只顯示部分 email（maskEmail）", () => {
  it("保留前兩個字和網域", () => {
    assert.equal(maskEmail("liana@gmail.com"), "li***@gmail.com");
    assert.equal(maskEmail("a@x.com"), "a***@x.com");
  });
  it("不是 email 的格式就整個遮掉", () => {
    assert.equal(maskEmail("not-an-email"), "***");
  });
});
