// 取得目前登入的人和他的角色。權限判斷一律走這裡，
// Better Auth 文件提醒只看 cookie 存不存在並不安全，要驗證 session。
// 只能在伺服器端 import。

import { getAuth, isAuthConfigured } from "./auth";
import { roleForUser, type MemberRole } from "./members";

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
