// 第 5b 步：「完成連接」寫進資料庫。用假資料庫（helpers/fake-db.ts）檢查送出的查詢和值，不連線。
// 資料庫的唯一性規則名稱是否真的對得上，用 npm run db:check 在 dev 驗證。

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  completeConnection,
  connectedClubSummary,
  isGoogleAccountConnected,
  reasonForUniqueViolation,
  type CompleteConnectionInput,
} from "../club-connect/complete.ts";
import { bindingFor, decryptSecret, parseKey } from "../crypto/secret-box.ts";
import { createFakeDb, type RecordedQuery } from "./helpers/fake-db.ts";

const KEY = parseKey(Buffer.alloc(32, 5).toString("base64"));
const NEW_CLUB = "33333333-3333-4333-8333-333333333333";
const OTHER_CLUB = "44444444-4444-4444-8444-444444444444";
const FAKE_REFRESH = "1//fake-refresh-token-DO-NOT-STORE-PLAIN";

const INPUT: CompleteConnectionInput = {
  userId: "user-liana",
  userEmail: " Liana@Example.com ",
  clubName: "台大熱舞社",
  googleEmail: "Club.Account@Gmail.com",
  refreshToken: FAKE_REFRESH,
  scopes: ["https://www.googleapis.com/auth/gmail.send", "openid", "https://www.googleapis.com/auth/drive.file"],
};

interface Scenario {
  memberExists?: boolean;
  connectionExists?: boolean;
  /** 在某一句 insert 時模擬資料庫錯誤 */
  failOn?: { table: "club_connection" | "club_member"; error: unknown };
}

function setup(scenario: Scenario = {}) {
  return createFakeDb((query) => {
    if (query.sql.startsWith('select "club_id" from "club_member"')) {
      return scenario.memberExists ? [{ club_id: OTHER_CLUB }] : [];
    }
    if (query.sql.startsWith('select "club_id" from "club_connection"')) {
      return scenario.connectionExists ? [{ club_id: OTHER_CLUB }] : [];
    }
    if (scenario.failOn && query.sql.startsWith(`insert into "${scenario.failOn.table}"`)) {
      throw scenario.failOn.error;
    }
    if (query.sql.startsWith('insert into "club"')) return [{ id: NEW_CLUB }];
    return [];
  });
}

const inserts = (queries: RecordedQuery[]) => queries.filter((q) => q.sql.startsWith("insert"));
const insertInto = (queries: RecordedQuery[], table: string) => {
  const found = queries.find((q) => q.sql.startsWith(`insert into "${table}"`));
  assert.ok(found, `沒有寫入 ${table}`);
  return found;
};
/** 從 insert 的 SQL 和參數，還原成「欄位 → 值」 */
function valuesOf(query: RecordedQuery): Record<string, unknown> {
  const columns = query.sql.match(/\(([^)]*)\) values/)?.[1].split(", ").map((c) => c.replaceAll('"', "")) ?? [];
  return Object.fromEntries(columns.map((c, i) => [c, query.parameters[i]]));
}

const uniqueViolation = (constraint: string) => Object.assign(new Error("duplicate key"), { code: "23505", constraint });

describe("完成連接：成功", () => {
  it("在同一個交易裡建立社團、社團連接、公關長，並提交", async () => {
    const { db, queries, transactions } = setup();
    assert.deepEqual(await completeConnection(db, INPUT, KEY), { ok: true, clubId: NEW_CLUB });
    assert.deepEqual(transactions, ["begin", "commit"]);
    assert.deepEqual(
      inserts(queries).map((q) => q.sql.match(/^insert into "(\w+)"/)?.[1]),
      ["club", "club_connection", "club_member"],
    );
  });

  it("社團名稱照公關長填的", async () => {
    const { db, queries } = setup();
    await completeConnection(db, INPUT, KEY);
    assert.deepEqual(valuesOf(insertInto(queries, "club")), { name: "台大熱舞社" });
  });

  it("社團連接：email 轉小寫、記錄連接者、權限排序存起來", async () => {
    const { db, queries } = setup();
    await completeConnection(db, INPUT, KEY);
    const row = valuesOf(insertInto(queries, "club_connection"));
    assert.equal(row.club_id, NEW_CLUB);
    assert.equal(row.google_email, "club.account@gmail.com");
    assert.equal(row.connected_by_user_id, "user-liana");
    assert.equal(row.connected_by_email, "liana@example.com");
    assert.equal(
      row.scope,
      "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/gmail.send openid",
    );
  });

  it("token 加密後才存，而且綁定這個新社團", async () => {
    const { db, queries } = setup();
    await completeConnection(db, INPUT, KEY);
    const sealed = String(valuesOf(insertInto(queries, "club_connection")).encrypted_refresh_token);
    assert.match(sealed, /^v1:/);
    assert.equal(decryptSecret(sealed, KEY, bindingFor("club_refresh_token", NEW_CLUB)), FAKE_REFRESH);
    assert.throws(() => decryptSecret(sealed, KEY, bindingFor("club_refresh_token", OTHER_CLUB)));
  });

  it("任何一句 SQL 的參數裡都找不到明文 token", async () => {
    const { db, queries } = setup();
    await completeConnection(db, INPUT, KEY);
    for (const query of queries) {
      assert.equal(JSON.stringify(query.parameters).includes(FAKE_REFRESH), false, query.sql);
    }
  });

  it("連接者成為這個社團的公關長（email 轉小寫）", async () => {
    const { db, queries } = setup();
    await completeConnection(db, INPUT, KEY);
    assert.deepEqual(valuesOf(insertInto(queries, "club_member")), {
      club_id: NEW_CLUB,
      email: "liana@example.com",
      role: "pr_lead",
    });
  });
});

describe("完成連接：擋下，不寫任何資料", () => {
  it("發起人已經屬於某個社團（一人一社團）", async () => {
    const { db, queries } = setup({ memberExists: true });
    assert.deepEqual(await completeConnection(db, INPUT, KEY), { ok: false, reason: "already_member" });
    assert.deepEqual(inserts(queries), []);
    // 用小寫的 email 查
    assert.deepEqual(queries[0].parameters, ["liana@example.com"]);
  });

  it("社團 Google 帳號已經連接過（重新連接的處理方式未定，先擋下）", async () => {
    const { db, queries } = setup({ connectionExists: true });
    assert.deepEqual(await completeConnection(db, INPUT, KEY), {
      ok: false,
      reason: "club_account_already_connected",
    });
    assert.deepEqual(inserts(queries), []);
  });
});

describe("完成連接：同時有人搶先（資料庫唯一性規則擋下）", () => {
  it("社團帳號被別人搶先連接 → 整個交易取消，回傳擋下", async () => {
    const { db, transactions } = setup({
      failOn: { table: "club_connection", error: uniqueViolation("club_connection_google_email_key") },
    });
    assert.deepEqual(await completeConnection(db, INPUT, KEY), {
      ok: false,
      reason: "club_account_already_connected",
    });
    assert.deepEqual(transactions, ["begin", "rollback"]);
  });

  it("發起人同時被加進別的社團 → 整個交易取消，回傳擋下", async () => {
    const { db, transactions } = setup({
      failOn: { table: "club_member", error: uniqueViolation("club_member_email_key") },
    });
    assert.deepEqual(await completeConnection(db, INPUT, KEY), { ok: false, reason: "already_member" });
    assert.deepEqual(transactions, ["begin", "rollback"]);
  });

  it("其他資料庫錯誤 → 交易取消，錯誤照常拋出（不假裝成功或擋下）", async () => {
    const boom = Object.assign(new Error("connection lost"), { code: "08006" });
    const { db, transactions } = setup({ failOn: { table: "club_member", error: boom } });
    await assert.rejects(completeConnection(db, INPUT, KEY), (error) => error === boom);
    assert.deepEqual(transactions, ["begin", "rollback"]);
  });
});

describe("唯一性錯誤對應（reasonForUniqueViolation）", () => {
  it("認得兩條唯一性規則", () => {
    assert.equal(reasonForUniqueViolation(uniqueViolation("club_member_email_key")), "already_member");
    assert.equal(
      reasonForUniqueViolation(uniqueViolation("club_connection_google_email_key")),
      "club_account_already_connected",
    );
  });

  it("其他規則、其他錯誤代碼、不是錯誤物件 → 不認得", () => {
    assert.equal(reasonForUniqueViolation(uniqueViolation("club_spreadsheet_id_key")), null);
    assert.equal(reasonForUniqueViolation({ code: "23514", constraint: "club_member_email_key" }), null);
    assert.equal(reasonForUniqueViolation(null), null);
    assert.equal(reasonForUniqueViolation("23505"), null);
  });
});

describe("社團帳號是否已連接（isGoogleAccountConnected，決定能不能撤銷）", () => {
  it("用小寫 email 查；查到就是已連接", async () => {
    const connected = setup({ connectionExists: true });
    assert.equal(await isGoogleAccountConnected(connected.db, " Club.Account@Gmail.com"), true);
    assert.deepEqual(connected.queries[0].parameters, ["club.account@gmail.com"]);

    const fresh = setup();
    assert.equal(await isGoogleAccountConnected(fresh.db, "club.account@gmail.com"), false);
  });
});

describe("首頁連接完成訊息要用的社團資料（connectedClubSummary）", () => {
  it("用社團ID 查社團名稱和社團 Google 帳號", async () => {
    const { db, queries } = createFakeDb(() => [{ name: "台大熱舞社", google_email: "club.account@gmail.com" }]);
    assert.deepEqual(await connectedClubSummary(db, NEW_CLUB), { name: "台大熱舞社", googleEmail: "club.account@gmail.com" });
    assert.match(queries[0].sql, /from "club" inner join "club_connection" on "club_connection"\."club_id" = "club"\."id" where "club"\."id" = \$1/);
    assert.deepEqual(queries[0].parameters, [NEW_CLUB]);
  });

  it("沒有連接紀錄 → null", async () => {
    const { db } = createFakeDb(() => []);
    assert.equal(await connectedClubSummary(db, NEW_CLUB), null);
  });
});
