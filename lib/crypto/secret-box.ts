// 機密的加解密（D-027）：社團帳號的 refresh token，之後社團的 API key 也共用。只能在伺服器端 import。
//
// 做法：AES-256-GCM（Node 內建 crypto），鑰匙是環境變數 TOKEN_ENCRYPTION_KEY（32 bytes，base64）。
// - 每次加密用新的隨機 IV（12 bytes），同一段文字加密兩次結果也不同
// - GCM 的驗證碼（auth tag）讓任何竄改都解不開
// - 綁定「用途＋社團ID」（AAD）：A 社團的密文搬到 B 社團、或 refresh token 拿去當 API key，都解不開
//
// 存成的格式：v1:<IV>:<密文>:<驗證碼>（各段 base64url）。開頭的 v1 是版本，之後換鑰匙或換做法時用來分辨。
// 錯誤訊息一律是固定文字，不包含鑰匙、原文或密文。

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type SecretBoxErrorCode = "invalid_key" | "invalid_input" | "decrypt_failed";

const MESSAGES: Record<SecretBoxErrorCode, string> = {
  invalid_key: "加密鑰匙設定不正確（TOKEN_ENCRYPTION_KEY 必須是 32 bytes 的 base64）",
  invalid_input: "要加密或解密的資料格式不正確",
  decrypt_failed: "解密失敗：鑰匙不對、資料被改過，或不屬於這個社團／用途",
};

export class SecretBoxError extends Error {
  readonly code: SecretBoxErrorCode;

  constructor(code: SecretBoxErrorCode) {
    super(MESSAGES[code]);
    this.name = "SecretBoxError";
    this.code = code;
  }
}

/** 加密的東西拿來做什麼；跟社團ID一起綁進密文 */
/**
 * 加密的東西拿來做什麼，以及 ownerId 是誰的 ID：
 * - club_refresh_token、club_api_key：社團ID
 * - club_connect_attempt：發起「連接社團帳號」的個人帳號 user id（存在 cookie 的連接中資料）
 */
export type SecretPurpose = "club_refresh_token" | "club_api_key" | "club_connect_attempt";

/** 綁定的內容（AAD）。不是機密，但解密時必須完全一樣才解得開 */
export function bindingFor(purpose: SecretPurpose, ownerId: string): string {
  if (typeof ownerId !== "string" || ownerId.trim() === "") throw new SecretBoxError("invalid_input");
  return `sponsor-mate:${purpose}:${ownerId}`;
}

/** 把 base64 字串轉成鑰匙；長度或格式不對就報錯（錯誤訊息不包含鑰匙內容） */
export function parseKey(base64Key: string | undefined): Buffer {
  const text = base64Key?.trim() ?? "";
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new SecretBoxError("invalid_key");
  const key = Buffer.from(text, "base64");
  // Buffer.from 遇到不合法的 base64 不會報錯，所以轉回去比對，確定沒有被默默丟掉字元
  if (key.length !== KEY_BYTES || key.toString("base64") !== text) throw new SecretBoxError("invalid_key");
  return key;
}

/** 從環境變數讀鑰匙 */
export function getEncryptionKey(env: Record<string, string | undefined> = process.env): Buffer {
  return parseKey(env.TOKEN_ENCRYPTION_KEY);
}

export function encryptSecret(plaintext: string, key: Buffer, binding: string): string {
  if (typeof plaintext !== "string" || plaintext === "") throw new SecretBoxError("invalid_input");
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new SecretBoxError("invalid_key");

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(binding, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, iv, ciphertext, tag]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(":");
}

export function decryptSecret(payload: string, key: Buffer, binding: string): string {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new SecretBoxError("invalid_key");
  if (typeof payload !== "string") throw new SecretBoxError("invalid_input");

  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new SecretBoxError("invalid_input");
  const [iv, ciphertext, tag] = parts.slice(1).map((part) => {
    if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new SecretBoxError("invalid_input");
    return Buffer.from(part, "base64url");
  });
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || ciphertext.length === 0) {
    throw new SecretBoxError("invalid_input");
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(binding, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // 不保留原始錯誤：裡面可能有難以預料的細節
    throw new SecretBoxError("decrypt_failed");
  }
}
