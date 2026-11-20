// 連接社團帳號的設定：缺任何一項（包含鑰匙格式不對）就回傳 null，網址會顯示「還沒設定完成」。

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readClubConnectConfig } from "../club-connect/deps.ts";

const FULL = {
  BETTER_AUTH_SECRET: "s",
  BETTER_AUTH_URL: "http://localhost:3000",
  GOOGLE_CLIENT_ID: "id",
  GOOGLE_CLIENT_SECRET: "secret",
  DATABASE_URL: "postgres://u:p@127.0.0.1:1/x",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
};

describe("連接社團帳號的設定（readClubConnectConfig）", () => {
  it("全部都有 → 回傳設定，鑰匙是 32 bytes", () => {
    const config = readClubConnectConfig(FULL);
    assert.equal(config?.baseUrl, "http://localhost:3000");
    assert.equal(config?.key.length, 32);
  });

  it("沒有 TOKEN_ENCRYPTION_KEY、或格式不對 → null", () => {
    assert.equal(readClubConnectConfig({ ...FULL, TOKEN_ENCRYPTION_KEY: undefined }), null);
    assert.equal(readClubConnectConfig({ ...FULL, TOKEN_ENCRYPTION_KEY: "too-short" }), null);
  });

  it("登入相關的設定缺一項 → null", () => {
    for (const name of ["BETTER_AUTH_URL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "DATABASE_URL"] as const) {
      assert.equal(readClubConnectConfig({ ...FULL, [name]: undefined }), null, `少了 ${name}`);
    }
  });
});
