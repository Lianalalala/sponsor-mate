// 取得目前登入的人和他的角色。權限判斷一律走這裡，
// Better Auth 文件提醒只看 cookie 存不存在並不安全，要驗證 session。
// 只能在伺服器端 import。
//
// 角色的資料來源目前是環境變數（lib/members.ts）；之後搬到資料庫（D-021）時，
// 只要換掉 roleForUser 的資料來源，下面的權限規則不用改。

import { getAuth, isAuthConfigured } from "./auth.ts";
import { roleForUser, type MemberRole } from "./members.ts";

export interface CurrentUser {
  email: string;
  name: string;
  role: MemberRole | null;
}

export async function getCurrentUser(requestHeaders: Headers): Promise<CurrentUser | null> {
  if (!isAuthConfigured()) return null;
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  if (!session) return null;
  const { email, name, emailVerified } = session.user;
  return { email, name, role: roleForUser({ email, emailVerified }) };
}

export type ImportAccess =
  | { allowed: true; user: CurrentUser }
  | { allowed: false; status: 401; reason: "not_signed_in" }
  | { allowed: false; status: 403; reason: "not_pr_lead" };

/**
 * 匯入舊資料（Data washing machine）只開放公關長（D-014）。
 * 名單外、Email 未驗證的人 role 是 null，和組員一樣擋下。
 */
export function importAccessFor(user: CurrentUser | null): ImportAccess {
  if (!user) return { allowed: false, status: 401, reason: "not_signed_in" };
  if (user.role !== "pr_lead") return { allowed: false, status: 403, reason: "not_pr_lead" };
  return { allowed: true, user };
}

export async function checkImportAccess(requestHeaders: Headers): Promise<ImportAccess> {
  return importAccessFor(await getCurrentUser(requestHeaders));
}
