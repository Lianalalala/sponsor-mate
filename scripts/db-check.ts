// 在真的資料庫上確認三張表的檢查規則有生效（npm test 不連資料庫，測不到這一層）。
// 用法：npm run db:check（要先 npm run db:migrate -- --apply）
//
// 所有測試資料都在一個交易（transaction）裡，跑完整個取消（rollback），資料庫不會留下任何東西。
// 只印測試名稱和結果，不印連線字串或資料內容。
// 只在本機對 dev branch 跑，不要對正式環境跑。

import { sql, type Kysely, type Transaction } from "kysely";

import { completeConnectionIn, reasonForUniqueViolation } from "../lib/club-connect/complete.ts";
import { parseKey } from "../lib/crypto/secret-box.ts";
import { createDb, isDatabaseConfigured, type Database } from "../lib/db/index.ts";

if (!isDatabaseConfigured()) {
  console.error("找不到 DATABASE_URL。請確認 .env.local 有設定，並用 npm run db:check 執行。");
  process.exit(1);
}

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FAKE_TOKEN = "v1:fake-iv:fake-ciphertext:fake-tag";
// 檢查用的假鑰匙和假 token：不用 .env.local 的 TOKEN_ENCRYPTION_KEY，資料最後也會全部取消
const CHECK_KEY = parseKey(Buffer.alloc(32, 9).toString("base64"));
const CONNECT_INPUT = {
  userId: "check-lead",
  userEmail: "check-connect-lead@example.com",
  clubName: "檢查用社團（連接）",
  googleEmail: "check-club-account@example.com",
  refreshToken: "1//fake-refresh-token-for-db-check",
  scopes: ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/drive.file"],
};

/** 檢查項目自己判斷不符合預期時拋出 */
class CheckFailed extends Error {}

type Expect = "accept" | { reject: string };
interface Case {
  name: string;
  expect: Expect;
  run: (trx: Transaction<Database>, clubId: string) => Promise<unknown>;
}

const insertConnection = (
  trx: Transaction<Database>,
  clubId: string,
  token: string | null,
  revokedAt: Date | null,
) =>
  trx
    .insertInto("club_connection")
    .values({
      club_id: clubId,
      google_email: "club-check@example.com",
      encrypted_refresh_token: token,
      scope: "gmail.send drive.file",
      connected_by_user_id: "check-script",
      connected_by_email: "check-script@example.com",
      revoked_at: revokedAt,
    })
    .execute();

const CASES: Case[] = [
  // ── 社團連接的 token 狀態（11/20 決定）──
  { name: "有效：有 token、沒有撤銷時間", expect: "accept", run: (t, c) => insertConnection(t, c, FAKE_TOKEN, null) },
  { name: "失效：沒有 token、有撤銷時間", expect: "accept", run: (t, c) => insertConnection(t, c, null, new Date()) },
  {
    name: "拒絕：有 token 又有撤銷時間",
    expect: { reject: CHECK_VIOLATION },
    run: (t, c) => insertConnection(t, c, FAKE_TOKEN, new Date()),
  },
  {
    name: "拒絕：沒有 token 也沒有撤銷時間",
    expect: { reject: CHECK_VIOLATION },
    run: (t, c) => insertConnection(t, c, null, null),
  },
  {
    name: "拒絕：token 是空字串",
    expect: { reject: CHECK_VIOLATION },
    run: (t, c) => insertConnection(t, c, "", null),
  },
  {
    name: "有效 → 失效（清掉 token、填撤銷時間）可以",
    expect: "accept",
    run: async (t, c) => {
      await insertConnection(t, c, FAKE_TOKEN, null);
      await t
        .updateTable("club_connection")
        .set({ encrypted_refresh_token: null, revoked_at: new Date() })
        .where("club_id", "=", c)
        .execute();
    },
  },
  {
    name: "拒絕：標成失效卻忘了清掉 token",
    expect: { reject: CHECK_VIOLATION },
    run: async (t, c) => {
      await insertConnection(t, c, FAKE_TOKEN, null);
      await t.updateTable("club_connection").set({ revoked_at: new Date() }).where("club_id", "=", c).execute();
    },
  },
  // ── 其他規則 ──
  {
    name: "拒絕：成員 email 有大寫",
    expect: { reject: CHECK_VIOLATION },
    run: (t, c) =>
      t.insertInto("club_member").values({ club_id: c, email: "Check@Example.com", role: "member" }).execute(),
  },
  {
    name: "拒絕：角色不是公關長或組員",
    expect: { reject: CHECK_VIOLATION },
    run: (t, c) =>
      t
        .insertInto("club_member")
        .values({ club_id: c, email: "check-role@example.com", role: "admin" as "member" })
        .execute(),
  },
  {
    name: "拒絕：同一個 email 加兩次（一人一社團）",
    expect: { reject: UNIQUE_VIOLATION },
    run: async (t, c) => {
      const other = await t.insertInto("club").values({ name: "檢查用社團 B" }).returning("id").executeTakeFirstOrThrow();
      await t.insertInto("club_member").values({ club_id: c, email: "check-dup@example.com", role: "pr_lead" }).execute();
      await t
        .insertInto("club_member")
        .values({ club_id: other.id, email: "check-dup@example.com", role: "member" })
        .execute();
    },
  },
  {
    name: "拒絕：試算表 ID 有不合法的字元",
    expect: { reject: CHECK_VIOLATION },
    run: (t, c) => t.updateTable("club").set({ spreadsheet_id: "abc/../def" }).where("id", "=", c).execute(),
  },
  // ── 完成連接（lib/club-connect/complete.ts，第 5b 步）──
  {
    name: "完成連接：建立社團、社團連接（token 已加密）、公關長",
    expect: "accept",
    run: async (t) => {
      const result = await completeConnectionIn(t, CONNECT_INPUT, CHECK_KEY);
      if (!result.ok) throw new CheckFailed(`應該成功，卻回傳 ${result.reason}`);
      const club = await t.selectFrom("club").select("name").where("id", "=", result.clubId).executeTakeFirst();
      const conn = await t
        .selectFrom("club_connection")
        .select(["encrypted_refresh_token", "revoked_at"])
        .where("club_id", "=", result.clubId)
        .executeTakeFirst();
      const lead = await t
        .selectFrom("club_member")
        .select("role")
        .where("club_id", "=", result.clubId)
        .where("email", "=", "check-connect-lead@example.com")
        .executeTakeFirst();
      if (club?.name !== CONNECT_INPUT.clubName) throw new CheckFailed("社團名稱不對");
      if (!conn?.encrypted_refresh_token?.startsWith("v1:") || conn.revoked_at !== null) {
        throw new CheckFailed("社團連接沒有存成「有效」狀態");
      }
      if (conn.encrypted_refresh_token.includes(CONNECT_INPUT.refreshToken)) throw new CheckFailed("token 沒有加密");
      if (lead?.role !== "pr_lead") throw new CheckFailed("連接者沒有成為公關長");
    },
  },
  {
    name: "完成連接：同一個社團帳號再連一次 → 擋下（重新連接未定案）",
    expect: "accept",
    run: async (t) => {
      await completeConnectionIn(t, CONNECT_INPUT, CHECK_KEY);
      const again = await completeConnectionIn(
        t,
        { ...CONNECT_INPUT, userId: "check-other", userEmail: "check-connect-other@example.com" },
        CHECK_KEY,
      );
      if (again.ok || again.reason !== "club_account_already_connected") throw new CheckFailed("沒有擋下");
    },
  },
  {
    name: "唯一性規則名稱對得上：同一個社團帳號 → club_connection_google_email_key",
    expect: "accept",
    run: async (t, c) => {
      const other = await t.insertInto("club").values({ name: "檢查用社團 C" }).returning("id").executeTakeFirstOrThrow();
      await insertConnection(t, c, FAKE_TOKEN, null);
      await expectUniqueReason(() => insertConnection(t, other.id, FAKE_TOKEN, null), "club_account_already_connected");
    },
  },
  {
    name: "唯一性規則名稱對得上：同一個成員 email → club_member_email_key",
    expect: "accept",
    run: async (t, c) => {
      const add = () => t.insertInto("club_member").values({ club_id: c, email: "check-dup2@example.com", role: "member" }).execute();
      await add();
      await expectUniqueReason(add, "already_member");
    },
  },
];

/** 執行一次應該違反唯一性的操作，確認 reasonForUniqueViolation 認得出是哪一條規則 */
async function expectUniqueReason(run: () => Promise<unknown>, expected: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    const reason = reasonForUniqueViolation(error);
    if (reason !== expected) throw new CheckFailed(`認不出規則名稱（得到 ${reason ?? "null"}）`);
    return;
  }
  throw new CheckFailed("資料庫沒有拒絕");
}

class Rollback extends Error {}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

const db: Kysely<Database> = createDb(process.env.DATABASE_URL as string);
let failures = 0;

try {
  await db.transaction().execute(async (trx) => {
    const club = await trx.insertInto("club").values({ name: "檢查用社團" }).returning("id").executeTakeFirstOrThrow();

    for (const testCase of CASES) {
      // 每個情況前設存檔點，結束後回到存檔點，情況之間互不影響
      await sql`savepoint check_case`.execute(trx);
      let outcome: string;
      try {
        await testCase.run(trx, club.id);
        outcome = testCase.expect === "accept" ? "通過" : "失敗：資料庫沒有拒絕";
      } catch (error) {
        const code = errorCode(error);
        outcome =
          error instanceof CheckFailed
            ? `失敗：${error.message}`
            : testCase.expect !== "accept" && code === testCase.expect.reject
              ? "通過（資料庫拒絕了）"
              : `失敗：錯誤代碼 ${code ?? "未知"}`;
      }
      await sql`rollback to savepoint check_case`.execute(trx);
      if (outcome.startsWith("失敗")) failures++;
      console.log(`${outcome.startsWith("失敗") ? "✖" : "✔"} ${testCase.name}：${outcome}`);
    }

    // 不論結果，整個交易都取消
    throw new Rollback();
  });
} catch (error) {
  if (!(error instanceof Rollback)) {
    const kind = error instanceof Error ? errorCode(error) ?? error.name : "未知錯誤";
    console.error(`執行失敗（${kind}）。請確認已經跑過 npm run db:migrate -- --apply。`);
    failures++;
  }
} finally {
  await db.destroy();
}

console.log(failures === 0 ? `\n全部 ${CASES.length} 項通過，測試資料已全部取消。` : `\n${failures} 項失敗。`);
process.exitCode = failures === 0 ? 0 : 1;
