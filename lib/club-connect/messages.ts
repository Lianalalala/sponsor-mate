// 首頁依 ?connect=ok／?connect_error=<代碼> 顯示的固定訊息。
// 網址上的代碼是使用者可以自己改的，所以只認得清單裡的代碼，其他一律不顯示，也不會把網址內容印到畫面上。

import type { ConnectResultCode } from "./flow.ts";
import { clubConnectErrorMessage, type ClubConnectErrorCode } from "./oauth.ts";

const FLOW_MESSAGES: Record<Exclude<ConnectResultCode, ClubConnectErrorCode>, string> = {
  not_configured: "連接社團帳號的功能還沒設定完成，請聯絡專案開發者。",
  not_signed_in: "請先用個人 Google 帳號登入，再連接社團帳號。",
  email_not_verified_personal: "你的個人 Google 帳號 email 還沒驗證，請換一個已驗證的帳號登入。",
  already_member: "你已經是某個社團的成員，一個人只能屬於一個社團，所以不能再連接新的社團帳號。",
  club_account_already_connected:
    "這個社團 Google 帳號已經連接過系統了。重新連接的處理方式還在討論，目前先不開放，請聯絡專案開發者。",
  invalid_club_name: "社團名稱要 1～50 個字，不能有看不見的特殊字元，請重新填寫。",
  bad_request: "這次的請求無效，請回到首頁重新操作。",
  unexpected: "連接時發生錯誤，社團帳號沒有連接，請稍後再試。",
};

const OAUTH_CODES: readonly ClubConnectErrorCode[] = [
  "attempt_missing",
  "attempt_invalid",
  "attempt_expired",
  "state_mismatch",
  "user_mismatch",
  "google_denied",
  "invalid_callback",
  "token_exchange_failed",
  "invalid_token_response",
  "missing_refresh_token",
  "missing_scopes",
  "invalid_id_token",
  "email_not_verified",
];

export type ConnectNotice = { kind: "success" | "error"; message: string };

export function connectNotice(params: {
  connect?: string | string[];
  connect_error?: string | string[];
}): ConnectNotice | null {
  if (params.connect === "ok") {
    return { kind: "success", message: "社團帳號連接完成，你現在是這個社團的公關長。" };
  }
  const code = params.connect_error;
  if (typeof code !== "string") return null;
  if (Object.hasOwn(FLOW_MESSAGES, code)) {
    return { kind: "error", message: FLOW_MESSAGES[code as keyof typeof FLOW_MESSAGES] };
  }
  if ((OAUTH_CODES as readonly string[]).includes(code)) {
    return { kind: "error", message: clubConnectErrorMessage(code as ClubConnectErrorCode) };
  }
  return null;
}
