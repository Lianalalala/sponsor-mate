// 成員名單的角色判斷（membershipForUser）。用記憶體版名單，不連資料庫。

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from "kysely";

import type { Database } from "../db/index.ts";
import { dbMemberDirectory } from "../members-db.ts";
import { createMemoryDirectory, membershipForUser } from "../members.ts";

const CLUB = "11111111-1111-4111-8111-111111111111";
const rows = [
  { email: "lead@example.com", clubId: CLUB, role: "pr_lead" as const },
  { email: "m@example.com", clubId: CLUB, role: "member" as const },
];
const verified = (email: string) => ({ email, emailVerified: true });

describe("成員名單（membershipForUser）", () => {
  it("公關長和組員，並帶出所屬社團", async () => {
    const directory = createMemoryDirectory(rows);
    assert.deepEqual(await membershipForUser(verified("lead@example.com"), directory), { clubId: CLUB, role: "pr_lead" });
    assert.deepEqual(await membershipForUser(verified("m@example.com"), directory), { clubId: CLUB, role: "member" });
  });

  it("Email 大小寫和空白不影響：一律轉成小寫再查", async () => {
    const directory = createMemoryDirectory(rows);
    assert.equal((await membershipForUser(verified(" LEAD@example.COM "), directory))?.role, "pr_lead");
    assert.deepEqual(directory.queries, ["lead@example.com"]);
  });

  it("名單外的 Google 帳號沒有權限", async () => {
    assert.equal(await membershipForUser(verified("stranger@example.com"), createMemoryDirectory(rows)), null);
  });

  it("名單是空的時所有人都沒有權限", async () => {
    assert.equal(await membershipForUser(verified("lead@example.com"), createMemoryDirectory([])), null);
  });

  it("Email 未驗證沒有權限，而且連名單都不查", async () => {
    const directory = createMemoryDirectory(rows);
    assert.equal(await membershipForUser({ email: "lead@example.com", emailVerified: false }, directory), null);
    assert.deepEqual(directory.queries, []);
  });

  it("空的 email 沒有權限，不查名單", async () => {
    const directory = createMemoryDirectory(rows);
    assert.equal(await membershipForUser(verified("   "), directory), null);
    assert.deepEqual(directory.queries, []);
  });
});

describe("資料庫版的名單查詢（dbMemberDirectory）", () => {
  it("用參數查 club_member，不把 email 直接拼進 SQL", async () => {
    const queries: { sql: string; parameters: readonly unknown[] }[] = [];
    const db = new Kysely<Database>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (k) => new PostgresIntrospector(k),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
      log: (event) => {
        queries.push({ sql: event.query.sql, parameters: event.query.parameters });
      },
    });
    const tricky = "x'; drop table club_member; --@example.com";
    // DummyDriver 不會回傳資料，所以查不到人
    assert.equal(await dbMemberDirectory(db).findByEmail(tricky), null);
    await db.destroy();

    assert.equal(queries.length, 1);
    assert.equal(queries[0].sql, 'select "club_id", "role" from "club_member" where "email" = $1');
    assert.deepEqual(queries[0].parameters, [tricky]);
  });
});
