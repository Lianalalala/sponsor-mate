// 成員名單的資料庫查詢（club_member 表）。只能在伺服器端 import。

import type { Kysely } from "kysely";

import { getDb, type Database } from "./db/index.ts";
import type { MemberDirectory } from "./members.ts";

/**
 * 用資料庫查成員名單。不傳 db 時，第一次查詢才連資料庫（getDb），
 * 所以只是 import 這個檔案、或還沒設定 DATABASE_URL 時都不會出錯。
 */
export function dbMemberDirectory(db?: Kysely<Database>): MemberDirectory {
  return {
    async findByEmail(email) {
      const row = await (db ?? getDb())
        .selectFrom("club_member")
        .select(["club_id", "role"])
        .where("email", "=", email)
        .executeTakeFirst();
      return row ? { clubId: row.club_id, role: row.role } : null;
    },
  };
}
