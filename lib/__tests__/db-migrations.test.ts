// 第 2 步：社團、成員名單、社團連接三張表的結構。
// 用 Kysely 的 DummyDriver 執行 migration：只產生 SQL、不連資料庫，再檢查 SQL 內容。

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from "kysely";

import { migrations } from "../db/migrations.ts";

async function sqlOf(direction: "up" | "down"): Promise<string[]> {
  const statements: string[] = [];
  const db = new Kysely<unknown>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      statements.push(event.query.sql);
    },
  });
  for (const migration of Object.values(migrations)) {
    if (direction === "up") await migration.up(db);
    else await migration.down?.(db);
  }
  await db.destroy();
  return statements;
}

const createStatement = (statements: string[], table: string) => {
  const found = statements.find((s) => s.startsWith(`create table "${table}"`));
  assert.ok(found, `找不到 ${table} 的建表 SQL`);
  return found;
};

describe("migration 名稱", () => {
  it("依日期命名，排序就是執行順序", () => {
    const names = Object.keys(migrations);
    assert.deepEqual(names, [...names].sort());
    for (const name of names) assert.match(name, /^\d{4}-\d{2}-\d{2}-\d{3}-[a-z-]+$/);
  });
});

describe("建表（up）", () => {
  it("依序建立 club → club_member → club_connection（後兩張要參照 club）", async () => {
    const tables = (await sqlOf("up")).map((s) => s.match(/^create table "(\w+)"/)?.[1]);
    assert.deepEqual(tables, ["club", "club_member", "club_connection"]);
  });

  it("club：id、名稱、建立時間", async () => {
    const sql = createStatement(await sqlOf("up"), "club");
    assert.match(sql, /"id" uuid default gen_random_uuid\(\) primary key/);
    assert.match(sql, /"name" text not null/);
    assert.match(sql, /"created_at" timestamptz default now\(\) not null/);
  });

  it("club：試算表 ID 可為空、兩個社團不能共用同一份、格式跟 Sheets 底層一致", async () => {
    const sql = createStatement(await sqlOf("up"), "club");
    assert.match(sql, /"spreadsheet_id" text unique[,)]/);
    assert.doesNotMatch(sql, /"spreadsheet_id" text[^,]*not null/);
    assert.match(sql, /check \(spreadsheet_id ~ '\^\[A-Za-z0-9_-\]\+\$'\)/);
  });

  it("club_connection 沒有試算表 ID（試算表屬於社團，不跟著授權走）", async () => {
    const sql = createStatement(await sqlOf("up"), "club_connection");
    assert.doesNotMatch(sql, /spreadsheet/);
  });

  it("club_member：email 整張表唯一（一人只屬於一個社團）、一律小寫", async () => {
    const sql = createStatement(await sqlOf("up"), "club_member");
    assert.match(sql, /"email" text not null unique/);
    assert.match(sql, /check \(email = lower\(email\)\)/);
  });

  it("club_member：角色只能是公關長或組員", async () => {
    const sql = createStatement(await sqlOf("up"), "club_member");
    assert.match(sql, /check \(role in \('pr_lead', 'member'\)\)/);
  });

  it("club_member：屬於某個社團，社團刪除時成員一起刪", async () => {
    const sql = createStatement(await sqlOf("up"), "club_member");
    assert.match(sql, /"club_id" uuid not null references "club" \("id"\) on delete cascade/);
  });

  it("club_connection：一個社團一列（club_id 是主鍵）", async () => {
    const sql = createStatement(await sqlOf("up"), "club_connection");
    assert.match(sql, /"club_id" uuid primary key references "club" \("id"\) on delete cascade/);
  });

  it("club_connection：一個社團 Google 帳號只能連一個社團，email 一律小寫", async () => {
    const sql = createStatement(await sqlOf("up"), "club_connection");
    assert.match(sql, /"google_email" text not null unique/);
    assert.match(sql, /check \(google_email = lower\(google_email\)\)/);
  });

  it("club_connection：有加密 token、scope、連接者、連接時間，沒有存明文 token 的欄位", async () => {
    const sql = createStatement(await sqlOf("up"), "club_connection");
    for (const column of [
      "encrypted_refresh_token",
      "scope",
      "connected_by_user_id",
      "connected_by_email",
      "connected_at",
    ]) {
      assert.match(sql, new RegExp(`"${column}" \\w+`), `缺少欄位 ${column}`);
    }
    // 除了加密那一欄，不能有其他存 token 的欄位。
    // 只看欄位定義（名稱後面接型別），檢查規則的名稱（例如 club_connection_token_state）不算
    const tokenColumns = [...sql.matchAll(/"(\w*token\w*)" (?:text|varchar|bytea|jsonb?)\b/g)].map((m) => m[1]);
    assert.deepEqual(tokenColumns, ["encrypted_refresh_token"]);
  });

  it("club_connection：加密 token 可為空（授權失效時清掉）", async () => {
    const sql = createStatement(await sqlOf("up"), "club_connection");
    assert.match(sql, /"encrypted_refresh_token" text[,)]/);
    assert.doesNotMatch(sql, /"encrypted_refresh_token" text not null/);
  });

  it("club_connection：資料庫只接受「有效」「失效」兩種狀態", async () => {
    const sql = createStatement(await sqlOf("up"), "club_connection");
    assert.ok(
      sql.includes(
        "check ((encrypted_refresh_token is not null and encrypted_refresh_token <> '' and revoked_at is null) or (encrypted_refresh_token is null and revoked_at is not null))",
      ),
      "缺少 token 狀態檢查",
    );
  });

  it("club_connection：最後更新時間、撤銷時間都可為空（剛連接時兩個都是空的）", async () => {
    const sql = createStatement(await sqlOf("up"), "club_connection");
    assert.match(sql, /"last_refreshed_at" timestamptz[,)]/);
    assert.match(sql, /"revoked_at" timestamptz[,)]/);
  });
});

describe("還原（down）", () => {
  it("反過來刪：先刪參照 club 的兩張，最後刪 club", async () => {
    const dropped = (await sqlOf("down")).map((s) => s.match(/^drop table "(\w+)"/)?.[1]);
    assert.deepEqual(dropped, ["club_connection", "club_member", "club"]);
  });
});
