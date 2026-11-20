// 取得目前登入的人、他屬於哪個社團、是什麼角色。權限判斷一律走這裡，
// Better Auth 文件提醒只看 cookie 存不存在並不安全，要驗證 session。
// 只能在伺服器端 import。
//
// 角色來自資料庫的成員名單（lib/members-db.ts，D-021）；下面的權限規則跟資料來源無關。

import { getAuth, isAuthConfigured } from "./auth.ts";
import { dbMemberDirectory } from "./members-db.ts";
import { membershipForUser, type MemberDirectory, type MemberRole } from "./members.ts";

export interface CurrentUser {
  email: string;
  name: string;
  /** 不在名單上時為 null */
  clubId: string | null;
  /** 不在名單上、或 Email 未驗證時為 null */
  role: MemberRole | null;
}

export async function getCurrentUser(
  requestHeaders: Headers,
  directory: MemberDirectory = dbMemberDirectory(),
): Promise<CurrentUser | null> {
  if (!isAuthConfigured()) return null;
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  if (!session) return null;
  const { email, name, emailVerified } = session.user;
  const membership = await membershipForUser({ email, emailVerified }, directory);
  return { email, name, clubId: membership?.clubId ?? null, role: membership?.role ?? null };
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
  if (user.role !== "pr_lead" || !user.clubId) return { allowed: false, status: 403, reason: "not_pr_lead" };
  return { allowed: true, user };
}

export async function checkImportAccess(requestHeaders: Headers): Promise<ImportAccess> {
  return importAccessFor(await getCurrentUser(requestHeaders));
}
