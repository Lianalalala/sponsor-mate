// 在 Neon 建立／更新資料表。只在本機手動執行，不會在部署時自動跑。
//
// 用法：
//   npm run db:migrate              只列出會建立或修改哪些表，不改資料庫
//   npm run db:migrate -- --apply   真的執行
//
// 執行前先確認 .env.local 的 DATABASE_URL 指向哪個 Neon branch（本機開發用 dev，不是正式環境的 main）。
// 這個腳本不會印出連線字串、密碼或任何資料內容，只印表名和欄位名。

import { getMigrations } from "better-auth/db/migration";
import { Migrator } from "kysely/migration";

import { buildAuthOptions } from "../lib/auth.ts";
import { createDb, isDatabaseConfigured } from "../lib/db/index.ts";
import { migrations } from "../lib/db/migrations.ts";

const apply = process.argv.includes("--apply");

if (!isDatabaseConfigured()) {
  console.error("找不到 DATABASE_URL。請確認 .env.local 有設定，並用 npm run db:migrate 執行。");
  process.exit(1);
}

const db = createDb(process.env.DATABASE_URL as string);

try {
  // ── Better Auth 的表：user、session、account、verification ──
  // throwOnUnsafe: false → 有危險的變更時回傳清單，由下面統一擋下，不直接拋錯
  const auth = await getMigrations(buildAuthOptions(db), { throwOnUnsafe: false });

  if (auth.schemaProblems.length > 0 || auth.unsafeChanges.length > 0) {
    console.error("Better Auth 回報需要人工處理的問題，這次不執行：");
    for (const problem of [...auth.schemaProblems, ...auth.unsafeChanges]) console.error(`- ${problem}`);
    process.exitCode = 1;
  } else {
    const planned = [
      ...auth.toBeCreated.map((t) => `新建表 ${t.table}（${Object.keys(t.fields).join("、")}）`),
      ...auth.toBeAdded.map((t) => `${t.table} 加欄位：${Object.keys(t.fields).join("、")}`),
      ...auth.toBeAddedIndexes.map((i) => `${i.table} 加索引 ${i.name}`),
    ];

    console.log("Better Auth 的表：");
    if (planned.length === 0) {
      console.log("- 已是最新，不用改");
    } else {
      for (const line of planned) console.log(`- ${line}`);
      if (apply) {
        await auth.runMigrations();
        console.log("已執行。");
      } else {
        console.log("（只是列出來，沒有執行。確認後加 --apply 再跑一次。）");
      }
    }
  }

  // ── 我們自己的表：社團、成員名單、社團連接（lib/db/migrations.ts）──
  // Better Auth 有問題時不往下跑，避免只建了一半
  if (!process.exitCode) {
    const migrator = new Migrator({
      db,
      provider: { getMigrations: async () => migrations },
    });
    const pending = (await migrator.getMigrations()).filter((m) => !m.executedAt);

    console.log("我們自己的表：");
    if (pending.length === 0) {
      console.log("- 已是最新，不用改");
    } else {
      for (const m of pending) console.log(`- 待執行：${m.name}`);
      if (apply) {
        const { error, results } = await migrator.migrateToLatest();
        for (const r of results ?? []) console.log(`- ${r.migrationName}：${r.status === "Success" ? "完成" : r.status}`);
        if (error) {
          // 只印錯誤類型，不印 SQL 參數或連線資訊
          const kind = error instanceof Error ? (("code" in error && error.code) || error.name) : "未知錯誤";
          console.error(`執行失敗（${String(kind)}），失敗的 migration 已整個取消，沒有建一半的表。`);
          process.exitCode = 1;
        } else {
          console.log("已執行。");
        }
      } else {
        console.log("（只是列出來，沒有執行。確認後加 --apply 再跑一次。）");
      }
    }
  }
} catch (error) {
  // 連線錯誤的訊息可能包含主機名稱，只印錯誤類型
  const kind = error instanceof Error ? (("code" in error && error.code) || error.name) : "未知錯誤";
  console.error(`執行失敗（${String(kind)}）。請確認 DATABASE_URL 和網路連線。`);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
