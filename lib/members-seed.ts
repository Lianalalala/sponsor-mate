// 把舊的環境變數名單（PR_LEAD_EMAILS／MEMBER_EMAILS）搬進資料庫時的規劃（D-017 → D-021）。
// 只給 scripts/seed-members-from-env.ts 用，一次性；之後名單只從資料庫來。
//
// 原則：只新增，不改、不刪。已經在名單裡的人一律跳過並說明原因，不會把誰的角色改掉。

import { normalizeEmail, type MemberRole } from "./members.ts";

export function parseEmailList(list: string | undefined): string[] {
  const emails = (list ?? "").split(",").map(normalizeEmail).filter((email) => email !== "");
  return [...new Set(emails)];
}

export interface ExistingMember {
  email: string;
  clubId: string;
  role: MemberRole;
}

export interface SeedPlan {
  add: { email: string; role: MemberRole }[];
  skip: { email: string; reason: string }[];
}

export function planSeed(
  env: Record<string, string | undefined>,
  targetClubId: string | null,
  existing: readonly ExistingMember[],
): SeedPlan {
  const leads = parseEmailList(env.PR_LEAD_EMAILS);
  const members = parseEmailList(env.MEMBER_EMAILS);

  // 兩份名單都有的人以公關長為準（跟原本 roleForUser 的規則一樣）
  const wanted = new Map<string, MemberRole>();
  for (const email of members) wanted.set(email, "member");
  for (const email of leads) wanted.set(email, "pr_lead");

  const plan: SeedPlan = { add: [], skip: [] };
  for (const [email, role] of wanted) {
    const found = existing.find((m) => m.email === email);
    if (!found) {
      plan.add.push({ email, role });
    } else if (found.clubId !== targetClubId) {
      plan.skip.push({ email, reason: "已經屬於其他社團（一人只屬於一個社團）" });
    } else if (found.role !== role) {
      plan.skip.push({ email, reason: "已在名單裡但角色不同，不自動更改" });
    } else {
      plan.skip.push({ email, reason: "已在名單裡" });
    }
  }
  return plan;
}

/** 終端機只顯示部分 email，例如 li***@gmail.com */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 2)}***@${domain}`;
}
