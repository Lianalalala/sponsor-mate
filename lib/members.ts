// 成員名單。只要求基本資料的 Google 登入不受 Test users 限制，
// 任何 Google 帳號都能登入成功，所以「登入成功」不等於「有權限」。
// 不在名單裡一律沒有權限；之後名單會搬到資料庫。

export type MemberRole = "pr_lead" | "member";

export const ROLE_LABEL: Record<MemberRole, string> = {
  pr_lead: "公關長",
  member: "組員",
};

function parseEmails(list: string | undefined): Set<string> {
  return new Set(
    (list ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email !== ""),
  );
}

export function roleForUser(
  user: { email: string; emailVerified: boolean },
  env: Record<string, string | undefined> = process.env,
): MemberRole | null {
  if (!user.emailVerified) return null;
  const email = user.email.trim().toLowerCase();
  if (parseEmails(env.PR_LEAD_EMAILS).has(email)) return "pr_lead";
  if (parseEmails(env.MEMBER_EMAILS).has(email)) return "member";
  return null;
}
