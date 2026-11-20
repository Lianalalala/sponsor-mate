// 社團名稱的檢查。連接社團帳號時填、之後公關長編輯名稱時也用同一套規則。

export const CLUB_NAME_MAX_LENGTH = 50;

export type ClubNameResult = { ok: true; name: string } | { ok: false; message: string };

export function validateClubName(input: unknown): ClubNameResult {
  if (typeof input !== "string") return { ok: false, message: "請填社團名稱" };
  // 全形空白、換行等都當成空白；連續空白縮成一個
  const name = input.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (name === "") return { ok: false, message: "請填社團名稱" };
  // 看不見的控制字元（例如零寬字元）不允許，避免名稱看起來一樣其實不同
  if (/[\p{Cc}\p{Cf}]/u.test(name)) return { ok: false, message: "社團名稱有無法顯示的字元，請重新輸入" };
  if ([...name].length > CLUB_NAME_MAX_LENGTH) {
    return { ok: false, message: `社團名稱最多 ${CLUB_NAME_MAX_LENGTH} 個字` };
  }
  return { ok: true, name };
}
