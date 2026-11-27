import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createClubSpreadsheet, SpreadsheetCreationError } from "../create-spreadsheet.ts";
import {
  provisionClubSpreadsheet,
  type ProvisioningActor,
  type ProvisioningDeps,
  type ProvisioningOperation,
  type ProvisioningReservation,
  type ProvisioningStage,
  type ProvisioningState,
} from "../provisioning.ts";
import { SHEET_DEFINITIONS } from "../schema.ts";

// 全部為離線 placeholder、虛構社團與假儲存，不讀環境變數或使用真正的登入／憑證。
const PLACEHOLDER = "offline-placeholder";
const SHEET = "offline-sheet-a";
const DIAGNOSTIC = "private-diagnostic";
type Mutable<T> = { -readonly [P in keyof T]: T[P] };
type MemoryState = Mutable<Omit<ProvisioningState, "operation">> & {
  operation: Mutable<ProvisioningOperation> | null;
};

/**
 * 模擬正式 adapter 的承諾，不是 Neon 實作。
 * 同一 Map 模擬資格已保存；這些測試不驗收跨程序持久化或 PostgreSQL 併發。
 */
function memory() {
  return {
    sequence: 0,
    rows: new Map<string, MemoryState>(["a", "b"].map((suffix): [string, MemoryState] => {
      const clubId = "club-" + suffix;
      return [clubId, { clubId, clubName: "虛構社團 " + suffix, spreadsheetId: null, operation: null }];
    })),
    stages: new Map<string, ProvisioningStage>(),
  };
}

function fixture(shared = memory()) {
  const events: string[] = [];
  const session: { actor: ProvisioningActor | null } = { actor: { clubId: "club-a", role: "pr_lead" } };
  const row = (clubId = "club-a") => {
    const value = shared.rows.get(clubId);
    assert.ok(value);
    return value;
  };
  const operation = (clubId: string, operationId: string) => {
    const value = row(clubId);
    assert.equal(value.operation?.operationId, operationId, "寫入須符合相同社團與作業");
    assert.ok(value.operation);
    return { value, op: value.operation };
  };
  const deps: ProvisioningDeps = {
    async getActor() { events.push("actor"); return session.actor; },
    async getAccessToken(clubId) { events.push("token:" + clubId); return PLACEHOLDER; },
    async createClubSpreadsheet(value, name) {
      events.push("create");
      assert.equal(value, PLACEHOLDER);
      assert.equal(name, row(session.actor?.clubId ?? "club-a").clubName);
      assert.equal(row(session.actor?.clubId ?? "club-a").operation?.status, "in_progress");
      return session.actor?.clubId === "club-b" ? "offline-sheet-b" : SHEET;
    },
    store: {
      async readState(clubId) {
        events.push("read:" + clubId);
        return shared.rows.has(clubId) ? structuredClone(row(clubId)) : null;
      },
      async reserve(clubId) {
        events.push("reserve:" + clubId);
        const value = row(clubId);
        if (value.spreadsheetId) return { status: "existing", clubId, spreadsheetId: value.spreadsheetId };
        if (value.operation) {
          assert.notEqual(value.operation.status, "completed");
          return { status: value.operation.status as "in_progress" | "needs_review", clubId,
            operationId: value.operation.operationId, spreadsheetId: value.operation.spreadsheetId };
        }
        // 假 adapter 在檢查與保留之間不 await，模擬資料庫的原子性契約。
        const operationId = "operation-" + (++shared.sequence);
        value.operation = { operationId, status: "in_progress", spreadsheetId: null };
        return { status: "reserved", clubId, clubName: value.clubName, operationId };
      },
      async recordKnownId(clubId, operationId, spreadsheetId, stage) {
        events.push("record:" + stage);
        const { op } = operation(clubId, operationId);
        assert.notEqual(op.status, "completed");
        assert.ok(op.spreadsheetId === null || op.spreadsheetId === spreadsheetId);
        op.spreadsheetId = spreadsheetId;
        shared.stages.set(operationId, stage);
      },
      async complete(clubId, operationId, spreadsheetId) {
        events.push("complete");
        const { value, op } = operation(clubId, operationId);
        assert.equal(op.spreadsheetId, spreadsheetId);
        assert.ok(value.spreadsheetId === null || value.spreadsheetId === spreadsheetId);
        value.spreadsheetId = spreadsheetId;
        op.status = "completed";
      },
      async markNeedsReview(clubId, operationId, reason) {
        events.push("review:" + reason);
        const { op } = operation(clubId, operationId);
        assert.notEqual(op.status, "completed", "不能把已完成的作業降級");
        op.status = "needs_review";
      },
    },
  };
  return { deps, shared, events, session, row };
}

function count(events: string[], event: string) {
  return events.filter((value) => value === event).length;
}

function pending(h: ReturnType<typeof fixture>, status: "in_progress" | "needs_review", spreadsheetId: string | null = null) {
  h.row().operation = { operationId: "older-operation", status, spreadsheetId };
}

describe("Sheets provisioning 核心（注入依賴，完全離線）", () => {
  for (const actor of [
    null,
    { role: "member", clubId: "club-a" },
    { role: null, clubId: "club-a" }, // 對應 Email 未驗證或不在名單的後端結果。
    { role: "pr_lead", clubId: null },
    { role: "pr_lead", clubId: "" },
    { role: "member", clubId: "club-a", canCreate: true },
  ] as const) {
    it("未登入或無有效公關長社團資格時，不能查資料／取 token／建表：" + JSON.stringify(actor), async () => {
      const h = fixture();
      h.session.actor = actor;
      assert.deepEqual(await provisionClubSpreadsheet(h.deps), {
        status: "blocked", code: actor === null ? "not_signed_in" : "forbidden",
      });
      assert.deepEqual(h.events, ["actor"]);
    });
  }

  it("Session 查核失敗只回固定代碼，不洩漏原始錯誤", async () => {
    const h = fixture();
    h.deps.getActor = async () => { throw new Error(DIAGNOSTIC); };
    assert.deepEqual(await provisionClubSpreadsheet(h.deps), { status: "blocked", code: "session_unavailable" });
    assert.equal(h.events.length, 0);
  });

  it("狀態讀取失敗與社團不存在分開處理，均不得假設可以建立", async () => {
    for (const fails of [true, false]) {
      const h = fixture();
      h.deps.store.readState = async () => {
        if (fails) throw new Error(DIAGNOSTIC);
        return null;
      };
      assert.deepEqual(await provisionClubSpreadsheet(h.deps), {
        status: "blocked", code: fails ? "state_unavailable" : "club_not_found",
      });
      assert.deepEqual(h.events, ["actor"]);
    }
  });

  for (const invalid of [
    { clubId: "club-b", clubName: "其他社團", spreadsheetId: "other-sheet", operation: null },
    { clubId: "club-a", clubName: "虛構", spreadsheetId: "" , operation: null },
    { clubId: "club-a", clubName: "虛構", spreadsheetId: null }, // 缺少 operation 不能當 null。
    { clubId: "club-a", clubName: "虛構", spreadsheetId: null,
      operation: { operationId: "op", status: "unknown", spreadsheetId: null } },
    { clubId: "club-a", clubName: "虛構", spreadsheetId: null,
      operation: { operationId: "op", status: "completed", spreadsheetId: SHEET } },
    { clubId: "club-a", clubName: "虛構", spreadsheetId: SHEET,
      operation: { operationId: "op", status: "in_progress", spreadsheetId: SHEET } },
  ]) {
    it("跨社團、缺漏或矛盾狀態一律停止：" + JSON.stringify(invalid), async () => {
      const h = fixture();
      h.deps.store.readState = async () => invalid as ProvisioningState;
      assert.deepEqual(await provisionClubSpreadsheet(h.deps), { status: "blocked", code: "invalid_state" });
      assert.equal(count(h.events, "create"), 0);
      assert.equal(count(h.events, "token:club-a"), 0);
    });
  }

  it("已有綁定直接回傳；支援既有資料，完全不取 token 或保留新作業", async () => {
    for (const hasOperation of [false, true]) {
      const h = fixture();
      h.row().spreadsheetId = SHEET;
      if (hasOperation) h.row().operation = { operationId: "completed-op", status: "completed", spreadsheetId: SHEET };
      assert.deepEqual(await provisionClubSpreadsheet(h.deps), { status: "ready", spreadsheetId: SHEET, source: "existing" });
      assert.deepEqual(h.events, ["actor", "read:club-a"]);
    }
  });

  for (const status of ["in_progress", "needs_review"] as const) {
    it("未決作業（包括半成品）不能當作未建立：" + status, async () => {
      const h = fixture();
      pending(h, status, SHEET);
      const result = await provisionClubSpreadsheet(h.deps);
      assert.equal(result.status, status);
      assert.ok(result.status === "in_progress" || result.status === "needs_review");
      assert.equal(result.spreadsheetId, SHEET);
      assert.deepEqual(h.events, ["actor", "read:club-a"]);
    });
  }

  for (const invalidToken of ["", " has-space", "line\nbreak", null, undefined]) {
    it("取不到有效憑證時不保留作業或建表：" + JSON.stringify(invalidToken), async () => {
      const h = fixture();
      h.deps.getAccessToken = async () => invalidToken as string;
      assert.deepEqual(await provisionClubSpreadsheet(h.deps), { status: "blocked", code: "authorization_failed" });
      assert.equal(h.row().operation, null);
      assert.equal(count(h.events, "create"), 0);
    });
  }

  it("取 token 拋錯時不讀取例外細節，也不建立作業", async () => {
    const h = fixture();
    h.deps.getAccessToken = async () => { throw new Error(PLACEHOLDER + DIAGNOSTIC); };
    assert.deepEqual(await provisionClubSpreadsheet(h.deps), { status: "blocked", code: "authorization_failed" });
    assert.equal(h.row().operation, null);
  });

  it("確認作業保留後才建表；記錄 ID 後才能完成綁定；再次呼叫不建立第二份", async () => {
    const h = fixture();
    assert.deepEqual(await provisionClubSpreadsheet(h.deps), { status: "ready", spreadsheetId: SHEET, source: "created" });
    assert.deepEqual(h.events, ["actor", "read:club-a", "token:club-a", "reserve:club-a", "create", "record:save", "complete"]);
    assert.equal(h.row().spreadsheetId, SHEET);
    assert.equal(h.row().operation?.status, "completed");
    assert.deepEqual(await provisionClubSpreadsheet(h.deps), { status: "ready", spreadsheetId: SHEET, source: "existing" });
    assert.equal(count(h.events, "create"), 1);
  });

  it("社團名稱採用 reserve 時後端查得的版本", async () => {
    const h = fixture();
    h.deps.getAccessToken = async () => {
      h.row().clubName = "更正後的虛構社團";
      return PLACEHOLDER;
    };
    const result = await provisionClubSpreadsheet(h.deps);
    assert.equal(result.status, "ready"); // fixture 的 Google 替身會核對此刻資料庫的名稱。
  });

  it("作業識別視為後端 opaque ID，不替 Neon 指定 UUID 或英數字編碼格式", async () => {
    const h = fixture();
    const reserve = h.deps.store.reserve;
    h.deps.store.reserve = async (clubId) => {
      const result = await reserve(clubId);
      assert.ok(result.status === "reserved");
      const operationId = "attempt:club-a:1";
      h.row().operation!.operationId = operationId;
      return { ...result, operationId };
    };
    assert.deepEqual(await provisionClubSpreadsheet(h.deps), { status: "ready", spreadsheetId: SHEET, source: "created" });
    assert.equal(h.row().operation?.operationId, "attempt:club-a:1");
  });

  it("兩個同時請求依賴 store 原子保留，只建立一次（不代表真實資料庫併發驗收）", async () => {
    const h = fixture();
    const results = await Promise.all([provisionClubSpreadsheet(h.deps), provisionClubSpreadsheet(h.deps)]);
    assert.equal(count(h.events, "create"), 1);
    assert.equal(results.filter((r) => r.status === "ready" && r.source === "created").length, 1);
    assert.ok(results.every((r) => r.status === "ready" || r.status === "in_progress"));
  });

  for (const status of ["existing", "in_progress", "needs_review"] as const) {
    it("初次讀取後有人搶先完成或保留作業，reserve 必須重新判斷：" + status, async () => {
      const h = fixture();
      h.deps.getAccessToken = async () => {
        if (status === "existing") h.row().spreadsheetId = SHEET;
        else pending(h, status, SHEET);
        return PLACEHOLDER;
      };
      const result = await provisionClubSpreadsheet(h.deps);
      assert.equal(result.status, status === "existing" ? "ready" : status);
      assert.equal(count(h.events, "create"), 0);
    });
  }

  it("reserve 提交前後出錯都不能重試；提交後讀回未決作業", async () => {
    for (const committed of [false, true]) {
      const h = fixture();
      const reserve = h.deps.store.reserve;
      let attempts = 0;
      h.deps.store.reserve = async (clubId) => {
        attempts++;
        if (committed) await reserve(clubId);
        throw new Error(DIAGNOSTIC);
      };
      const result = await provisionClubSpreadsheet(h.deps);
      assert.equal(result.status, committed ? "in_progress" : "needs_review");
      assert.equal(attempts, 1);
      assert.equal(count(h.events, "read:club-a"), 2);
      assert.equal(count(h.events, "create"), 0);
    }
  });

  it("reserve 回應遺失後若另一作業已完成，可讀回既有綁定", async () => {
    const h = fixture();
    h.deps.store.reserve = async () => {
      h.row().spreadsheetId = SHEET;
      throw new Error(DIAGNOSTIC);
    };
    assert.deepEqual(await provisionClubSpreadsheet(h.deps), { status: "ready", spreadsheetId: SHEET, source: "existing" });
    assert.equal(count(h.events, "create"), 0);
  });

  it("reserve 與讀回都失敗時保持未確認，不繼續建表", async () => {
    const h = fixture();
    h.deps.store.reserve = async () => {
      h.deps.store.readState = async () => { throw new Error(DIAGNOSTIC); };
      throw new Error(DIAGNOSTIC);
    };
    assert.deepEqual(await provisionClubSpreadsheet(h.deps), {
      status: "needs_review", reason: "reservation_unconfirmed",
      operationId: null, spreadsheetId: null, reviewRecorded: false,
    });
    assert.equal(count(h.events, "create"), 0);
  });

  for (const response of [
    { status: "reserved", clubId: "club-b", clubName: "其他社團", operationId: "foreign-op" },
    { status: "reserved", clubId: "club-a", clubName: "虛構", operationId: "" },
    { status: "reserved", clubId: "club-a", clubName: "", operationId: "op" },
    { status: "unrecognized", clubId: "club-a", operationId: "op", spreadsheetId: null },
  ]) {
    it("無效保留回應不能授權建表或回傳其他社團識別：" + JSON.stringify(response), async () => {
      const h = fixture();
      h.deps.store.reserve = async () => response as ProvisioningReservation;
      assert.deepEqual(await provisionClubSpreadsheet(h.deps), {
        status: "needs_review", reason: "invalid_state", operationId: null, spreadsheetId: null, reviewRecorded: false,
      });
      assert.equal(count(h.events, "create"), 0);
    });
  }

  const failures = [
    { error: new SpreadsheetCreationError("invalid_input", "not_attempted", "create"), reason: "creation_not_attempted" },
    { error: new SpreadsheetCreationError("authorization", "rejected", "create", undefined, 403), reason: "creation_rejected" },
    { error: new SpreadsheetCreationError("request_failed", "unknown", "create"), reason: "creation_unknown" },
    { error: new SpreadsheetCreationError("invalid_response", "unknown", "create", SHEET), reason: "creation_unknown" },
    { error: new SpreadsheetCreationError("authorization", "rejected", "initialize", SHEET, 403), reason: "initialization_failed" },
    { error: new SpreadsheetCreationError("request_failed", "unknown", "initialize", SHEET), reason: "initialization_failed" },
    { error: new Error(DIAGNOSTIC + PLACEHOLDER), reason: "creation_unknown" },
    { error: { spreadsheetId: "untrusted-id", message: DIAGNOSTIC }, reason: "creation_unknown" },
  ] as const;
  for (const [index, { error, reason }] of failures.entries()) {
    it("建立失敗不重試、不完成綁定；保留已知 ID 與階段：" + reason + "/" + index, async () => {
      const h = fixture();
      h.deps.createClubSpreadsheet = async () => { h.events.push("create"); throw error; };
      const result = await provisionClubSpreadsheet(h.deps);
      const knownId = error instanceof SpreadsheetCreationError ? error.spreadsheetId ?? null : null;
      assert.equal(result.status, "needs_review");
      assert.ok(result.status === "needs_review");
      assert.equal(result.reason, reason);
      assert.equal(result.spreadsheetId, knownId);
      assert.equal(result.reviewRecorded, true);
      assert.equal(h.row().spreadsheetId, null);
      assert.equal(h.row().operation?.spreadsheetId, knownId);
      assert.equal(h.row().operation?.status, "needs_review");
      assert.equal(count(h.events, "create"), 1);
      assert.equal(count(h.events, "complete"), 0);
      if (knownId) {
        assert.ok(error instanceof SpreadsheetCreationError);
        assert.equal(h.shared.stages.get(h.row().operation!.operationId), error.stage);
      }
      assert.equal(JSON.stringify(result).includes(DIAGNOSTIC), false);
      assert.equal(JSON.stringify(result).includes(PLACEHOLDER), false);
      assert.equal((await provisionClubSpreadsheet(h.deps)).status, "needs_review");
      assert.equal(count(h.events, "create"), 1);
    });
  }

  for (const invalidId of ["", "not/an/id", null, undefined]) {
    it("建表回傳缺漏或不合法 ID，不能標記成功：" + JSON.stringify(invalidId), async () => {
      const h = fixture();
      h.deps.createClubSpreadsheet = async () => invalidId as string;
      const result = await provisionClubSpreadsheet(h.deps);
      assert.ok(result.status === "needs_review");
      assert.equal(result.reason, "invalid_creation_response");
      assert.equal(count(h.events, "complete"), 0);
    });
  }

  it("記錄 ID 在提交前或提交後出錯，都保留已知 ID 並停止，不接著綁定", async () => {
    for (const committed of [false, true]) {
      const h = fixture();
      const record = h.deps.store.recordKnownId;
      h.deps.store.recordKnownId = async (...args) => {
        if (committed) await record(...args);
        throw new Error(DIAGNOSTIC);
      };
      const result = await provisionClubSpreadsheet(h.deps);
      assert.ok(result.status === "needs_review");
      assert.equal(result.reason, "record_id_unconfirmed");
      assert.equal(result.spreadsheetId, SHEET);
      assert.equal(count(h.events, "read:club-a"), 2);
      assert.equal(count(h.events, "complete"), 0);
      assert.equal(h.row().spreadsheetId, null);
      assert.equal(h.row().operation?.status, "needs_review");
    }
  });

  it("ID 保存回應遺失後讀回也失敗，仍回報已知 ID 並保留作業", async () => {
    const h = fixture();
    h.deps.store.recordKnownId = async () => {
      h.deps.store.readState = async () => { throw new Error(DIAGNOSTIC); };
      throw new Error(DIAGNOSTIC);
    };
    const result = await provisionClubSpreadsheet(h.deps);
    assert.ok(result.status === "needs_review");
    assert.equal(result.reason, "record_id_unconfirmed");
    assert.equal(result.spreadsheetId, SHEET);
    assert.equal(count(h.events, "complete"), 0);
    assert.equal(h.row().operation?.status, "needs_review");
  });

  it("ID 保存回應遺失，但授權恢復流程已完成同一作業，可讀回確認而不再寫入", async () => {
    const h = fixture();
    const record = h.deps.store.recordKnownId;
    const complete = h.deps.store.complete;
    h.deps.store.recordKnownId = async (...args) => {
      await record(...args);
      await complete(args[0], args[1], args[2]); // 模擬另一個已驗證的恢復流程完成。
      throw new Error(DIAGNOSTIC);
    };
    assert.deepEqual(await provisionClubSpreadsheet(h.deps), { status: "ready", spreadsheetId: SHEET, source: "created" });
    assert.equal(count(h.events, "record:save"), 1);
    assert.equal(count(h.events, "complete"), 1);
    assert.equal(h.events.some((e) => e.startsWith("review:")), false);
  });

  it("半成品 ID 保存失敗仍回報已知 ID，不遺失或重建", async () => {
    const h = fixture();
    h.deps.createClubSpreadsheet = async () => { throw new SpreadsheetCreationError("request_failed", "unknown", "initialize", SHEET); };
    h.deps.store.recordKnownId = async () => { throw new Error(DIAGNOSTIC); };
    const result = await provisionClubSpreadsheet(h.deps);
    assert.ok(result.status === "needs_review");
    assert.equal(result.reason, "record_id_unconfirmed");
    assert.equal(result.spreadsheetId, SHEET);
    assert.equal(count(h.events, "read:club-a"), 2);
    assert.equal(count(h.events, "complete"), 0);
  });

  it("Google 完成但綁定未提交：讀回核對後進入待核對，不重做 Google 或 complete", async () => {
    const h = fixture();
    let attempts = 0;
    h.deps.store.complete = async () => { attempts++; throw new Error(DIAGNOSTIC); };
    const result = await provisionClubSpreadsheet(h.deps);
    assert.ok(result.status === "needs_review");
    assert.equal(result.reason, "binding_unconfirmed");
    assert.equal(result.spreadsheetId, SHEET);
    assert.equal(count(h.events, "read:club-a"), 2);
    assert.equal(count(h.events, "create"), 1);
    assert.equal(attempts, 1);
    assert.equal(h.row().operation?.status, "needs_review");
  });

  it("綁定已提交但回應遺失：同一作業、同一 ID 讀回成立才回成功，不降級完成狀態", async () => {
    const h = fixture();
    const complete = h.deps.store.complete;
    h.deps.store.complete = async (...args) => { await complete(...args); throw new Error(DIAGNOSTIC); };
    assert.deepEqual(await provisionClubSpreadsheet(h.deps), { status: "ready", spreadsheetId: SHEET, source: "created" });
    assert.equal(h.row().operation?.status, "completed");
    assert.equal(count(h.events, "complete"), 1);
    assert.equal(h.events.some((e) => e.startsWith("review:")), false);
  });

  it("綁定出錯且讀回失敗，仍保留作業與 ID，不回成功", async () => {
    const h = fixture();
    h.deps.store.complete = async () => {
      h.deps.store.readState = async () => { throw new Error(DIAGNOSTIC); };
      throw new Error(DIAGNOSTIC);
    };
    const result = await provisionClubSpreadsheet(h.deps);
    assert.ok(result.status === "needs_review");
    assert.equal(result.reason, "binding_unconfirmed");
    assert.equal(result.spreadsheetId, SHEET);
    assert.equal(h.row().operation?.status, "needs_review");
  });

  for (const mismatch of ["operation", "spreadsheet", "club"] as const) {
    it("綁定讀回須符合原社團、作業與 ID，不能採用其他完成紀錄：" + mismatch, async () => {
      const h = fixture();
      h.deps.store.complete = async () => {
        h.deps.store.readState = async () => ({
          clubId: mismatch === "club" ? "club-b" : "club-a", clubName: "虛構",
          spreadsheetId: mismatch === "spreadsheet" ? "other-sheet" : SHEET,
          operation: { operationId: mismatch === "operation" ? "other-operation" : h.row().operation!.operationId,
            status: "completed", spreadsheetId: mismatch === "spreadsheet" ? "other-sheet" : SHEET },
        });
        throw new Error(DIAGNOSTIC);
      };
      const result = await provisionClubSpreadsheet(h.deps);
      assert.ok(result.status === "needs_review");
      assert.equal(result.spreadsheetId, SHEET);
      assert.equal(result.reason, "binding_unconfirmed");
    });
  }

  it("連待核對也寫入失敗，原始作業保留仍阻擋；新核心實例也不得重建", async () => {
    const h = fixture();
    h.deps.createClubSpreadsheet = async () => { h.events.push("create"); throw new Error(DIAGNOSTIC); };
    h.deps.store.markNeedsReview = async () => { throw new Error(DIAGNOSTIC); };
    const result = await provisionClubSpreadsheet(h.deps);
    assert.ok(result.status === "needs_review");
    assert.equal(result.reviewRecorded, false);
    assert.equal(h.row().operation?.status, "in_progress");
    // 共享假儲存模擬重啟後仍可讀到作業，不是實際跨程序／Neon 持久化測試。
    const nextInstance = fixture(h.shared);
    assert.equal((await provisionClubSpreadsheet(nextInstance.deps)).status, "in_progress");
    assert.equal(count(nextInstance.events, "create"), 0);
  });

  it("不同社團各自保留與綁定，不互用 ID 或作業", async () => {
    const a = fixture();
    const b = fixture(a.shared);
    b.session.actor = { clubId: "club-b", role: "pr_lead" };
    const [first, second] = await Promise.all([provisionClubSpreadsheet(a.deps), provisionClubSpreadsheet(b.deps)]);
    assert.deepEqual(first, { status: "ready", spreadsheetId: SHEET, source: "created" });
    assert.deepEqual(second, { status: "ready", spreadsheetId: "offline-sheet-b", source: "created" });
    assert.notEqual(a.row().operation?.operationId, b.row("club-b").operation?.operationId);
    assert.equal(a.row().spreadsheetId, SHEET);
    assert.equal(b.row("club-b").spreadsheetId, "offline-sheet-b");
    assert.equal(count(b.events, "token:club-a"), 0);
  });

  for (const mode of ["success", "initialize_rejected", "create_unknown"] as const) {
    it("接既有建表函式與模擬 HTTP，驗證兩階段流程：" + mode, async () => {
      const h = fixture();
      let httpCalls = 0;
      h.deps.createClubSpreadsheet = (accessToken, name) => createClubSpreadsheet(accessToken, name, async (_url, init) => {
        httpCalls++;
        assert.equal(h.row().operation?.status, "in_progress", "發 HTTP 前資格必須已保留");
        assert.equal(h.row().spreadsheetId, null, "初始化完成前不能綁定");
        if (httpCalls === 1) {
          if (mode === "create_unknown") throw new Error(DIAGNOSTIC);
          return Response.json({ spreadsheetId: SHEET,
            sheets: SHEET_DEFINITIONS.map((sheet) => ({ properties: { sheetId: sheet.sheetId, title: sheet.title } })),
          });
        }
        if (mode === "initialize_rejected") return new Response(null, { status: 403 });
        const body = JSON.parse(String(init?.body)) as { requests: unknown[] };
        return Response.json({ spreadsheetId: SHEET, replies: body.requests.map(() => ({})) });
      });
      const result = await provisionClubSpreadsheet(h.deps);
      assert.equal(httpCalls, mode === "create_unknown" ? 1 : 2);
      assert.equal(result.status, mode === "success" ? "ready" : "needs_review");
      assert.equal(h.row().spreadsheetId, mode === "success" ? SHEET : null);
      if (mode === "initialize_rejected") {
        assert.equal(h.row().operation?.spreadsheetId, SHEET);
        assert.equal(h.shared.stages.get(h.row().operation!.operationId), "initialize");
      }
    });
  }
});
