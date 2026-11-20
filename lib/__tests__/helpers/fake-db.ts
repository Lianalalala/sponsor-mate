// 測試用的假資料庫：不連線，照測試寫好的規則回傳資料，並記錄每一句 SQL 和參數、交易有沒有提交。
// 用來測「程式會送出哪些查詢、送出什麼值」。資料庫本身的規則（唯一、檢查）要用 npm run db:check 在 dev 測。

import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type QueryResult,
} from "kysely";

import type { Database } from "../../db/index.ts";

export interface RecordedQuery {
  sql: string;
  parameters: readonly unknown[];
}

/** 收到一句 SQL 時要回傳哪些列；也可以 throw 來模擬資料庫錯誤 */
export type Responder = (query: RecordedQuery) => Record<string, unknown>[];

export function createFakeDb(respond: Responder = () => []) {
  const queries: RecordedQuery[] = [];
  const transactions: ("begin" | "commit" | "rollback")[] = [];

  const connection: DatabaseConnection = {
    async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const query = { sql: compiled.sql, parameters: compiled.parameters };
      queries.push(query);
      return { rows: respond(query) as R[] };
    },
    async *streamQuery() {
      throw new Error("假資料庫不支援 streamQuery");
    },
  };

  const db = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
      createDriver: () => ({
        init: async () => {},
        acquireConnection: async () => connection,
        beginTransaction: async () => {
          transactions.push("begin");
        },
        commitTransaction: async () => {
          transactions.push("commit");
        },
        rollbackTransaction: async () => {
          transactions.push("rollback");
        },
        releaseConnection: async () => {},
        destroy: async () => {},
      }),
    },
  });

  return { db, queries, transactions };
}
