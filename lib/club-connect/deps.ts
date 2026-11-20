// 正式環境的「連接社團帳號」接線：真的登入資訊、真的資料庫、真的 Google。只能在伺服器端 import。
// 社團連接跟個人登入共用同一個 Google Cloud OAuth Client（GOOGLE_CLIENT_ID／SECRET），
// 但要的權限和 redirect URI 不同，token 也分開存。

import { getAuth, isAuthConfigured } from "../auth.ts";
import { getEncryptionKey } from "../crypto/secret-box.ts";
import { getDb } from "../db/index.ts";
import { dbMemberDirectory } from "../members-db.ts";
import { membershipForUser } from "../members.ts";
import { completeConnection, isGoogleAccountConnected } from "./complete.ts";
import type { ClubConnectConfig, ConnectDeps } from "./flow.ts";

type Env = Record<string, string | undefined>;

/** 設定不齊（包含鑰匙格式不對）時回傳 null；錯誤訊息不包含任何設定值 */
export function readClubConnectConfig(env: Env = process.env): ClubConnectConfig | null {
  if (!isAuthConfigured(env)) return null;
  try {
    return {
      clientId: env.GOOGLE_CLIENT_ID as string,
      clientSecret: env.GOOGLE_CLIENT_SECRET as string,
      baseUrl: env.BETTER_AUTH_URL as string,
      key: getEncryptionKey(env),
    };
  } catch {
    return null;
  }
}

export function createConnectDeps(): ConnectDeps | null {
  const config = readClubConnectConfig();
  if (!config) return null;
  const directory = dbMemberDirectory();
  return {
    config,
    async getSessionUser(headers) {
      const session = await getAuth().api.getSession({ headers });
      if (!session) return null;
      const { id, email, emailVerified } = session.user;
      return { id, email, emailVerified };
    },
    findMembership: (user) => membershipForUser(user, directory),
    complete: (input) => completeConnection(getDb(), input, config.key),
    isGoogleAccountConnected: (email) => isGoogleAccountConnected(getDb(), email),
    fetcher: (...args) => fetch(...args),
    now: () => Date.now(),
  };
}
