// 成員名單與角色（D-020）。只要求基本資料的 Google 登入不受 Test users 限制，
// 任何 Google 帳號都能登入成功，所以「登入成功」不等於「有權限」。
// 不在名單裡、或 Email 未驗證，一律沒有權限。
//
// 名單存在資料庫的 club_member 表（D-021）；查詢方式由 MemberDirectory 提供：
// 正式環境用 lib/members-db.ts，測試用 createMemoryDirectory，所以這裡的規則不必連資料庫就能測。

export type MemberRole = "pr_lead" | "member";

export const ROLE_LABEL: Record<MemberRole, string> = {
  pr_lead: "公關長",
  member: "組員",
};

/** 某個人屬於哪個社團、是什麼角色（一人只屬於一個社團，11/20 決定） */
export interface Membership {
  clubId: string;
  role: MemberRole;
}

/** 查成員名單的方式。傳進來的 email 一定已經是小寫、去掉前後空白 */
export interface MemberDirectory {
  findByEmail(email: string): Promise<Membership | null>;
}

/** 名單裡的 email 一律存小寫（資料庫也有檢查），查之前先統一格式 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function membershipForUser(
  user: { email: string; emailVerified: boolean },
  directory: MemberDirectory,
): Promise<Membership | null> {
  // Email 沒驗證過，就不能證明是本人，連名單都不查
  if (!user.emailVerified) return null;
  const email = normalizeEmail(user.email);
  if (email === "") return null;
  return directory.findByEmail(email);
}

/** 記憶體版的名單，給測試用 */
export function createMemoryDirectory(
  rows: readonly { email: string; clubId: string; role: MemberRole }[],
): MemberDirectory & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async findByEmail(email) {
      queries.push(email);
      const row = rows.find((r) => r.email === email);
      return row ? { clubId: row.clubId, role: row.role } : null;
    },
  };
}
