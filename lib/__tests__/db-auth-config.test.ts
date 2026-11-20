// 第 1 步：Better Auth 改接 Neon 的設定檢查。
// 不連資料庫、不讀 .env.local：環境變數一律用測試裡寫的假值。

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildAuthOptions, isAuthConfigured } from "../auth.ts";
import { createDb, getDb, isDatabaseConfigured } from "../db/index.ts";

const FULL_ENV = {
  BETTER_AUTH_SECRET: "test-secret",
  BETTER_AUTH_URL: "http://localhost:3000",
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  DATABASE_URL: "postgres://user:fake-password@127.0.0.1:1/test",
};

describe("登入設定是否齊全（isAuthConfigured）", () => {
  it("五個變數都有 → 齊全", () => {
    assert.equal(isAuthConfigured(FULL_ENV), true);
  });

  it("少了 DATABASE_URL → 不齊全（網站照樣能 build，登入顯示「還沒設定」）", () => {
    assert.equal(isAuthConfigured({ ...FULL_ENV, DATABASE_URL: undefined }), false);
  });

  it("只有空白也算沒設定", () => {
    assert.equal(isAuthConfigured({ ...FULL_ENV, DATABASE_URL: "   " }), false);
  });
});

describe("資料庫連線", () => {
  it("沒有 DATABASE_URL → isDatabaseConfigured 為 false", () => {
    assert.equal(isDatabaseConfigured({}), false);
    assert.equal(isDatabaseConfigured(FULL_ENV), true);
  });

  it("沒有 DATABASE_URL 時 getDb 報清楚的錯", () => {
    const env = process.env as Record<string, string | undefined>;
    const original = env.DATABASE_URL;
    delete env.DATABASE_URL;
    try {
      assert.throws(() => getDb(), /缺 DATABASE_URL/);
    } finally {
      if (original !== undefined) env.DATABASE_URL = original;
    }
  });

  it("建立連線池不會馬上連線（假的位址也不會出錯）", async () => {
    const db = createDb(FULL_ENV.DATABASE_URL);
    await db.destroy();
  });
});

describe("Better Auth 設定（buildAuthOptions）", () => {
  it("使用 Postgres，並跟我們的表共用同一個 Kysely", async () => {
    const db = createDb(FULL_ENV.DATABASE_URL);
    try {
      const options = buildAuthOptions(db, FULL_ENV);
      assert.equal(options.database.type, "postgres");
      assert.equal(options.database.db, db);
    } finally {
      await db.destroy();
    }
  });

  it("個人登入不要求 Gmail／Drive 權限（社團授權是另一段流程）", async () => {
    const db = createDb(FULL_ENV.DATABASE_URL);
    try {
      const google = buildAuthOptions(db, FULL_ENV).socialProviders.google;
      assert.equal("scope" in google, false);
      assert.doesNotMatch(JSON.stringify(google), /gmail|drive/i);
    } finally {
      await db.destroy();
    }
  });
});
