// 一次性：把 .env.local 的 PR_LEAD_EMAILS／MEMBER_EMAILS 搬進資料庫的「開發測試社團」。
//
// 用法：
//   npm run db:seed-members              只列出會做什麼，不改資料庫
//   npm run db:seed-members -- --apply   真的執行
//
// 只在本機對 Neon dev branch 跑。跑完就可以把 .env.local 裡這兩個變數刪掉，程式已經不讀它們了。
// 只新增，不改、不刪；可以重複跑，已經在名單裡的人會跳過。終端機只顯示部分 email。

import { createDb, isDatabaseConfigured } from "../lib/db/index.ts";
import { maskEmail, planSeed } from "../lib/members-seed.ts";
import { ROLE_LABEL } from "../lib/members.ts";

const CLUB_NAME = "開發測試社團";
const apply = process.argv.includes("--apply");

if (!isDatabaseConfigured()) {
  console.error("找不到 DATABASE_URL。請確認 .env.local 有設定，並用 npm run db:seed-members 執行。");
  process.exit(1);
}

const db = createDb(process.env.DATABASE_URL as string);

try {
  await db.transaction().execute(async (trx) => {
    const clubs = await trx.selectFrom("club").select("id").where("name", "=", CLUB_NAME).execute();
    if (clubs.length > 1) {
      throw new Error(`有 ${clubs.length} 個社團都叫「${CLUB_NAME}」，不知道要放進哪一個，這次不執行。`);
    }
    let clubId = clubs[0]?.id ?? null;

    const existing = await trx.selectFrom("club_member").select(["email", "club_id", "role"]).execute();
    const plan = planSeed(
      process.env,
      clubId,
      existing.map((m) => ({ email: m.email, clubId: m.club_id, role: m.role })),
    );

    console.log(`社團：${CLUB_NAME}（${clubId ? "已存在" : apply ? "新建" : "還不存在，執行時會新建"}）`);
    for (const { email, role } of plan.add) console.log(`- 新增 ${maskEmail(email)}：${ROLE_LABEL[role]}`);
    for (const { email, reason } of plan.skip) console.log(`- 跳過 ${maskEmail(email)}：${reason}`);
    if (plan.add.length === 0 && plan.skip.length === 0) {
      console.log("- 環境變數裡沒有任何 email（PR_LEAD_EMAILS／MEMBER_EMAILS 都是空的）");
    }

    if (!apply) {
      console.log("（只是列出來，沒有執行。確認後加 --apply 再跑一次。）");
      return;
    }
    if (plan.add.length === 0) {
      console.log("沒有要新增的人。");
      return;
    }

    clubId ??= (await trx.insertInto("club").values({ name: CLUB_NAME }).returning("id").executeTakeFirstOrThrow()).id;
    await trx
      .insertInto("club_member")
      .values(plan.add.map(({ email, role }) => ({ club_id: clubId as string, email, role })))
      .execute();
    console.log(`已新增 ${plan.add.length} 人。`);
  });
} catch (error) {
  // 自己丟的錯誤訊息可以直接顯示；資料庫錯誤只顯示類型
  const message =
    error instanceof Error && !("code" in error) ? error.message : `執行失敗（${String((error as { code?: unknown }).code ?? "未知")}）`;
  console.error(message, "沒有改任何資料。");
  process.exitCode = 1;
} finally {
  await db.destroy();
}
