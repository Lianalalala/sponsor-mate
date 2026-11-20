// 我們自己的表（D-020、D-021、D-027）。Better Auth 的表由 Better Auth 自己建，不在這裡。
//
// 規則：已經在任何資料庫（dev 或正式）執行過的 migration 不能再改，
// 要改結構就在下面新增一個 migration（名稱依日期排序）。

import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

export const migrations: Record<string, Migration> = {
  "2026-11-20-001-club-tables": {
    async up(db: Kysely<unknown>) {
      // 社團：一個社團一列
      await db.schema
        .createTable("club")
        .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
        .addColumn("name", "text", (col) => col.notNull())
        // 社團 Drive 裡那份資料庫試算表（D-013）；還沒建立前是空的。
        // 放在 club 而不是 club_connection：試算表屬於社團，授權過期、撤銷或重新連接都不能讓系統忘記它在哪。
        // 唯一：兩個社團不能指向同一份試算表，避免資料互相看到
        .addColumn("spreadsheet_id", "text", (col) => col.unique())
        .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
        // 跟 lib/sheets/transport.ts 的檢查一致：Google 試算表 ID 只有英數字、底線、連字號
        .addCheckConstraint("club_spreadsheet_id_format", sql`spreadsheet_id ~ '^[A-Za-z0-9_-]+$'`)
        .execute();

      // 成員名單：email、角色、社團（D-020）
      await db.schema
        .createTable("club_member")
        .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
        .addColumn("club_id", "uuid", (col) => col.notNull().references("club.id").onDelete("cascade"))
        // 一個人只能屬於一個社團（11/20 決定，MVP 限定）：email 在整張表只能出現一次
        .addColumn("email", "text", (col) => col.notNull().unique())
        .addColumn("role", "text", (col) => col.notNull())
        // 誰把他加進來的（個人帳號 email）；完成連接成為公關長、或從環境變數匯入的人留空
        .addColumn("invited_by_email", "text")
        .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
        // email 一律存小寫，比對時才不會因為大小寫不同而漏掉
        .addCheckConstraint("club_member_email_lowercase", sql`email = lower(email)`)
        .addCheckConstraint("club_member_role_valid", sql`role in ('pr_lead', 'member')`)
        .execute();

      // 社團連接：一個社團一列（club_id 是主鍵），存社團 Google 帳號的授權（D-027）
      await db.schema
        .createTable("club_connection")
        .addColumn("club_id", "uuid", (col) => col.primaryKey().references("club.id").onDelete("cascade"))
        // 同一個社團 Google 帳號只能連到一個社團
        .addColumn("google_email", "text", (col) => col.notNull().unique())
        // AES-256-GCM 加密後的 refresh token（lib/crypto），絕不存明文。
        // 授權失效時清掉（設為空），沒用的 token 不留在資料庫（11/20 決定）
        .addColumn("encrypted_refresh_token", "text")
        // Google 實際給的權限，例如 gmail.send、drive.file
        .addColumn("scope", "text", (col) => col.notNull())
        // 完成連接的人（個人帳號）。不設外鍵：就算那個人之後被移除，連接紀錄仍要保留
        .addColumn("connected_by_user_id", "text", (col) => col.notNull())
        .addColumn("connected_by_email", "text", (col) => col.notNull())
        .addColumn("connected_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
        // 最後一次成功用 refresh token 換到 access token 的時間；還沒換過是空的。
        // 測試模式下授權約 7 天失效（D-004），用來提醒公關長重新連接
        .addColumn("last_refreshed_at", "timestamptz")
        // 發現授權已失效（Google 回 invalid_grant、或社團在 Google 帳號撤銷）的時間；空的代表目前有效
        .addColumn("revoked_at", "timestamptz")
        .addCheckConstraint("club_connection_google_email_lowercase", sql`google_email = lower(google_email)`)
        // 只允許兩種狀態，其他組合資料庫直接拒絕：
        //   有效：有 token（不能是空字串）、沒有撤銷時間
        //   失效：沒有 token、有撤銷時間
        .addCheckConstraint(
          "club_connection_token_state",
          sql`(encrypted_refresh_token is not null and encrypted_refresh_token <> '' and revoked_at is null) or (encrypted_refresh_token is null and revoked_at is not null)`,
        )
        .execute();
    },

    async down(db: Kysely<unknown>) {
      await db.schema.dropTable("club_connection").execute();
      await db.schema.dropTable("club_member").execute();
      await db.schema.dropTable("club").execute();
    },
  },
};
