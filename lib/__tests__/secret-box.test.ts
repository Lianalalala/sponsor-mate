// 第 3 步：機密加解密（lib/crypto/secret-box.ts）。
// 鑰匙和 token 都是測試裡寫死的假值，不讀 .env.local。

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  bindingFor,
  decryptSecret,
  encryptSecret,
  getEncryptionKey,
  parseKey,
  SecretBoxError,
} from "../crypto/secret-box.ts";

const KEY_BASE64 = Buffer.alloc(32, 7).toString("base64");
const OTHER_KEY_BASE64 = Buffer.alloc(32, 8).toString("base64");
const KEY = parseKey(KEY_BASE64);
const OTHER_KEY = parseKey(OTHER_KEY_BASE64);

const FAKE_TOKEN = "1//fake-refresh-token-for-tests-ONLY";
const CLUB_A = "11111111-1111-4111-8111-111111111111";
const CLUB_B = "22222222-2222-4222-8222-222222222222";
const BINDING_A = bindingFor("club_refresh_token", CLUB_A);

function isError(code: SecretBoxError["code"]) {
  return (error: unknown) => error instanceof SecretBoxError && error.code === code;
}

/** 把密文某一段的第一個 byte 改掉，模擬資料被竄改 */
function tamper(payload: string, partIndex: 1 | 2 | 3): string {
  const parts = payload.split(":");
  const bytes = Buffer.from(parts[partIndex], "base64url");
  bytes[0] ^= 0x01;
  parts[partIndex] = bytes.toString("base64url");
  return parts.join(":");
}

describe("加密後解密回原文", () => {
  it("一般的 token", () => {
    const sealed = encryptSecret(FAKE_TOKEN, KEY, BINDING_A);
    assert.equal(decryptSecret(sealed, KEY, BINDING_A), FAKE_TOKEN);
  });

  it("中文、emoji、很長的內容也可以", () => {
    const text = "社團 API key 🔑 " + "x".repeat(5000);
    assert.equal(decryptSecret(encryptSecret(text, KEY, BINDING_A), KEY, BINDING_A), text);
  });

  it("格式是 v1:IV:密文:驗證碼", () => {
    const parts = encryptSecret(FAKE_TOKEN, KEY, BINDING_A).split(":");
    assert.equal(parts.length, 4);
    assert.equal(parts[0], "v1");
    assert.equal(Buffer.from(parts[1], "base64url").length, 12);
    assert.equal(Buffer.from(parts[3], "base64url").length, 16);
  });
});

describe("看不出原文", () => {
  it("同一段文字加密兩次，結果不同（每次用新的 IV）", () => {
    assert.notEqual(encryptSecret(FAKE_TOKEN, KEY, BINDING_A), encryptSecret(FAKE_TOKEN, KEY, BINDING_A));
  });

  it("密文裡找不到原文", () => {
    const sealed = encryptSecret(FAKE_TOKEN, KEY, BINDING_A);
    assert.equal(sealed.includes(FAKE_TOKEN), false);
    assert.equal(sealed.includes(Buffer.from(FAKE_TOKEN).toString("base64url")), false);
  });
});

describe("解不開的情況", () => {
  const sealed = encryptSecret(FAKE_TOKEN, KEY, BINDING_A);

  it("IV 被改過", () => {
    assert.throws(() => decryptSecret(tamper(sealed, 1), KEY, BINDING_A), isError("decrypt_failed"));
  });

  it("密文被改過", () => {
    assert.throws(() => decryptSecret(tamper(sealed, 2), KEY, BINDING_A), isError("decrypt_failed"));
  });

  it("驗證碼被改過", () => {
    assert.throws(() => decryptSecret(tamper(sealed, 3), KEY, BINDING_A), isError("decrypt_failed"));
  });

  it("換了鑰匙", () => {
    assert.throws(() => decryptSecret(sealed, OTHER_KEY, BINDING_A), isError("decrypt_failed"));
  });

  it("A 社團的密文搬到 B 社團", () => {
    const bindingB = bindingFor("club_refresh_token", CLUB_B);
    assert.throws(() => decryptSecret(sealed, KEY, bindingB), isError("decrypt_failed"));
  });

  it("refresh token 的密文拿去當 API key 解", () => {
    const apiKeyBinding = bindingFor("club_api_key", CLUB_A);
    assert.throws(() => decryptSecret(sealed, KEY, apiKeyBinding), isError("decrypt_failed"));
  });

  it("版本不認得、段數不對、有不合法字元 → 格式錯誤", () => {
    const [, iv, ct, tag] = sealed.split(":");
    for (const bad of [
      `v2:${iv}:${ct}:${tag}`,
      `v1:${iv}:${ct}`,
      `v1:${iv}:${ct}:${tag}:extra`,
      `v1:${iv}:${ct}:${tag}!`,
      `v1:${iv}::${tag}`,
      "",
      FAKE_TOKEN,
    ]) {
      assert.throws(() => decryptSecret(bad, KEY, BINDING_A), isError("invalid_input"), `應該擋下：${bad}`);
    }
  });
});

describe("鑰匙", () => {
  it("32 bytes 的 base64 才接受", () => {
    assert.equal(parseKey(KEY_BASE64).length, 32);
  });

  it("長度不對、不是 base64、空的 → 拒絕", () => {
    for (const bad of [
      Buffer.alloc(16, 1).toString("base64"),
      Buffer.alloc(31, 1).toString("base64"),
      Buffer.alloc(33, 1).toString("base64"),
      "這不是base64",
      KEY_BASE64.slice(0, -2) + "!!",
      "",
      "   ",
      undefined,
    ]) {
      assert.throws(() => parseKey(bad), isError("invalid_key"), `應該拒絕：${bad}`);
    }
  });

  it("從環境變數讀：沒設定就報錯", () => {
    assert.equal(getEncryptionKey({ TOKEN_ENCRYPTION_KEY: KEY_BASE64 }).length, 32);
    assert.throws(() => getEncryptionKey({}), isError("invalid_key"));
  });

  it("加解密時鑰匙長度不對 → 拒絕", () => {
    assert.throws(() => encryptSecret(FAKE_TOKEN, Buffer.alloc(16), BINDING_A), isError("invalid_key"));
    assert.throws(() => decryptSecret("v1:a:b:c", Buffer.alloc(16), BINDING_A), isError("invalid_key"));
  });
});

describe("其他輸入檢查", () => {
  it("不加密空字串", () => {
    assert.throws(() => encryptSecret("", KEY, BINDING_A), isError("invalid_input"));
  });

  it("社團ID不能是空的", () => {
    assert.throws(() => bindingFor("club_refresh_token", ""), isError("invalid_input"));
    assert.throws(() => bindingFor("club_refresh_token", "  "), isError("invalid_input"));
  });
});

describe("錯誤訊息不洩漏機密", () => {
  it("任何錯誤訊息都不包含鑰匙、原文或密文", () => {
    const sealed = encryptSecret(FAKE_TOKEN, KEY, BINDING_A);
    const errors: unknown[] = [];
    const attempts = [
      () => parseKey(KEY_BASE64.slice(0, -4)),
      () => decryptSecret(sealed, OTHER_KEY, BINDING_A),
      () => decryptSecret(tamper(sealed, 2), KEY, BINDING_A),
      () => decryptSecret(`v9:${sealed}`, KEY, BINDING_A),
    ];
    for (const attempt of attempts) {
      try {
        attempt();
      } catch (error) {
        errors.push(error);
      }
    }
    assert.equal(errors.length, attempts.length);
    for (const error of errors) {
      const text = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack ?? ""}`;
      for (const secret of [KEY_BASE64, OTHER_KEY_BASE64, FAKE_TOKEN, sealed.split(":")[2]]) {
        assert.equal(text.includes(secret), false);
      }
      // 解密失敗不保留底層錯誤
      assert.equal((error as Error).cause, undefined);
    }
  });
});
