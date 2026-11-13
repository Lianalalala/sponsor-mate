// 寫入計畫（D-025）：預覽頁一次處理完 → ①②③⑤各要寫什麼。用假的①②③資料，不連 Google。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { EMPTY_INTERPRETATION, type RowInterpretation } from "../interpretation.ts";
import { regroupDuplicates, washTable, type ColumnMapping, type WashedRow } from "../pipeline.ts";
import { fromStagingRow, STAGING_COLUMNS, toStagingRow, type StagingCell } from "../staging.ts";
import {
  confirmAllReady,
  EMPTY_CHOICES,
  NEW_VENDOR,
  reviewImport,
  setRowAction,
  type ExistingEvent,
  type ExistingRecord,
  type ExistingVendor,
  type ImportChoices,
  type ImportContext,
} from "../write-plan.ts";

const headers = ["廠商", "聯絡", "日期", "狀態", "活動", "負責人"];
const mapping: ColumnMapping = {
  vendorName: [0],
  contact: [1],
  contactDate: [2],
  status: [3],
  eventLabel: [4],
  owner: [5],
};

function wash(rows: string[][], ai = new Map<number, RowInterpretation>()): WashedRow[] {
  return washTable({ headers, rows }, mapping, ai).rows;
}

const batch = {
  batchId: "IMP-20261113-100000",
  sourceName: "old.xlsx",
  createdAt: "2026-11-13T10:00:00.000Z",
  createdBy: "lead@example.com",
};

const currentEvents: ExistingEvent[] = [{ id: "E-0001", name: "2026 迎新晚會", status: "招商中" }];
const existingVendors: ExistingVendor[] = [
  {
    id: "V-0003",
    name: "全家",
    email: "family@example.com",
    contactMethod: "Email",
    contactInfo: "",
    contactPerson: "王小姐",
    otherChannels: null,
    stopContact: false,
  },
];

function context(overrides: Partial<ImportContext> = {}): ImportContext {
  return { vendors: [], events: currentEvents, records: [], batch, ...overrides };
}

const stagingCell = (cells: StagingCell[], column: (typeof STAGING_COLUMNS)[number]) =>
  cells[STAGING_COLUMNS.indexOf(column)];

const confirm = (choices: ImportChoices, ...rowNumbers: number[]): ImportChoices => ({
  ...choices,
  actions: { ...choices.actions, ...Object.fromEntries(rowNumbers.map((n) => [n, "confirm" as const])) },
});

describe("舊活動 → 建立為歷史活動", () => {
  const rows = wash([
    ["甲咖啡", "cafe@example.com", "2024/12/01", "未聯絡", "2024耶誕舞會", "幹部A"],
    ["乙書店", "book@example.com", "2024/12/02", "未聯絡", "2024耶誕舞會", "幹部A"],
    ["丙工作室", "studio@example.com", "2026/09/01", "未聯絡", "迎新", "幹部B"],
  ]);
  const choices: ImportChoices = confirm(
    {
      ...EMPTY_CHOICES,
      eventByLabel: {
        "2024耶誕舞會": { kind: "history", name: "2024耶誕舞會" },
        迎新: { kind: "existing", eventId: "E-0001" },
      },
    },
    2,
    3,
    4,
  );
  const { plan, rows: reviews } = reviewImport(rows, choices, context());

  it("寫入計畫在②新增一列歷史活動；同名的舊活動只建一列", () => {
    assert.equal(plan.events.create.length, 1);
    assert.equal(plan.events.create[0].活動ID, "E-0002");
    assert.equal(plan.events.create[0].活動名稱, "2024耶誕舞會");
    assert.equal(plan.events.create[0].活動狀態, "歷史");
  });

  it("往來紀錄掛到正確的活動：歷史活動用新 ID，現行活動用既有 ID", () => {
    assert.deepEqual(
      plan.records.create.map((record) => record.活動ID),
      ["E-0002", "E-0002", "E-0001"],
    );
    for (const review of reviews.values()) assert.equal(review.writable, true);
  });

  it("每一家各新增到①，ID 接著既有的編", () => {
    assert.deepEqual(
      plan.vendors.create.map((vendor) => vendor.廠商ID),
      ["V-0001", "V-0002", "V-0003"],
    );
    const ids = reviewImport(rows, choices, context({ vendors: [{ ...existingVendors[0], name: "無關的店", email: null }] }))
      .plan.vendors.create.map((vendor) => vendor.廠商ID);
    assert.deepEqual(ids, ["V-0004", "V-0005", "V-0006"]);
  });

  it("②已經有同名的歷史活動 → 沿用，不重複新增", () => {
    const withHistory = context({ events: [...currentEvents, { id: "E-0007", name: "2024耶誕舞會", status: "歷史" }] });
    const result = reviewImport(rows, choices, withHistory);
    assert.equal(result.plan.events.create.length, 0);
    assert.equal(result.plan.records.create[0].活動ID, "E-0007");
  });

  it("沒選對應活動 → 不能確認", () => {
    const review = reviewImport(rows, EMPTY_CHOICES, context());
    const first = review.rows.get(2)!;
    assert.ok(first.blockers.some((blocker) => blocker.kind === "對應活動"));
    assert.deepEqual(setRowAction(review, EMPTY_CHOICES, 2, "confirm"), EMPTY_CHOICES);
  });
});

describe("跟①既有廠商比對", () => {
  const rows = wash([["全家", "窗口：陳先生；family@example.com", "2024/12/01", "已回覆", "迎新", "幹部A"]], new Map([
    [2, { ...EMPTY_INTERPRETATION, contactPerson: "陳先生" }],
  ]));
  const base: ImportChoices = confirm({ ...EMPTY_CHOICES, eventByLabel: { 迎新: { kind: "existing", eventId: "E-0001" } } }, 2);

  it("同名 → 出現合併選擇，還沒選不能寫入", () => {
    const review = reviewImport(rows, base, context({ vendors: existingVendors }));
    const unit = review.units.get("row:2")!;
    assert.deepEqual(unit.candidates.map((vendor) => vendor.id), ["V-0003"]);
    assert.equal(unit.match, null);
    assert.ok(review.rows.get(2)!.blockers.some((blocker) => blocker.kind === "既有廠商"));
    assert.equal(review.plan.records.create.length, 0);
  });

  it("選「同一廠商」→ 往來紀錄掛到既有的廠商 ID；窗口不一致要先選", () => {
    const same: ImportChoices = { ...base, vendorMatch: { "row:2": "V-0003" } };
    const pending = reviewImport(rows, same, context({ vendors: existingVendors }));
    const conflict = pending.units.get("row:2")!.conflicts.find((item) => item.field === "聯絡窗口");
    assert.ok(conflict, "①是王小姐、舊資料是陳先生 → 不一致");
    assert.deepEqual(conflict.options.map((option) => option.value), ["王小姐", "陳先生"]);
    assert.equal(pending.rows.get(2)!.writable, false);

    const chosen: ImportChoices = { ...same, fieldChoices: { "row:2": { 聯絡窗口: "陳先生" } } };
    const { plan } = reviewImport(rows, chosen, context({ vendors: existingVendors }));
    assert.equal(plan.vendors.create.length, 0);
    assert.equal(plan.records.create[0].廠商ID, "V-0003");
    assert.equal(plan.vendors.update[0].vendorId, "V-0003");
    assert.equal(plan.vendors.update[0].changes.聯絡窗口, "陳先生");
  });

  it("選「不同廠商」→ ①新增一家", () => {
    const separate: ImportChoices = { ...base, vendorMatch: { "row:2": NEW_VENDOR } };
    const { plan } = reviewImport(rows, separate, context({ vendors: existingVendors }));
    assert.equal(plan.vendors.create[0].廠商ID, "V-0004");
    assert.equal(plan.records.create[0].廠商ID, "V-0004");
  });

  it("③已經有這家廠商在同一個活動的紀錄 → 不能寫入", () => {
    const records: ExistingRecord[] = [{ id: "R-0009", vendorId: "V-0003", eventId: "E-0001" }];
    const same: ImportChoices = {
      ...base,
      vendorMatch: { "row:2": "V-0003" },
      fieldChoices: { "row:2": { 聯絡窗口: "陳先生" } },
    };
    const review = reviewImport(rows, same, context({ vendors: existingVendors, records }));
    assert.ok(review.rows.get(2)!.blockers.some((blocker) => blocker.kind === "往來紀錄重複"));
    assert.equal(review.plan.records.create.length, 0);
  });

  it("停止聯絡只會從「否」改成「是」", () => {
    const stopRows = wash([["全家", "family@example.com", "2024/12/01", "不要再聯絡", "迎新", "幹部A"]]);
    const choices: ImportChoices = { ...base, vendorMatch: { "row:2": "V-0003" } };
    const { plan } = reviewImport(stopRows, choices, context({ vendors: existingVendors }));
    assert.equal(plan.vendors.update[0].changes.廠商主動要求停止聯絡, "是");
  });
});

describe("缺聯絡資訊", () => {
  const rows = wash([["丁餐廳", "", "2025/10/01", "未聯絡", "迎新", "幹部A"]]);
  const choices: ImportChoices = { ...EMPTY_CHOICES, eventByLabel: { 迎新: { kind: "existing", eventId: "E-0001" } } };

  it("不能確認，但可以稍後處理 → 存進⑤標待處理", () => {
    const review = reviewImport(rows, choices, context());
    assert.ok(review.rows.get(2)!.blockers.some((blocker) => blocker.message === "沒有任何聯絡資訊"));
    assert.deepEqual(setRowAction(review, choices, 2, "confirm"), choices, "確認被擋下來");

    const later = setRowAction(review, choices, 2, "later");
    const result = reviewImport(rows, later, context());
    assert.equal(result.rows.get(2)!.confirmStatus, "待處理");
    assert.equal(result.plan.vendors.create.length, 0);
    assert.equal(result.plan.records.create.length, 0);
    assert.equal(stagingCell(result.plan.staging.append[0], "確認狀態"), "待處理");
  });

  it("就算動作被改成確認，也不會寫進①③", () => {
    const forged = confirm(choices, 2);
    const { plan } = reviewImport(rows, forged, context());
    assert.equal(plan.records.create.length, 0);
    assert.equal(stagingCell(plan.staging.append[0], "確認狀態"), "待處理");
  });
});

describe("疑似重複：選完合併決定就等於確認整組", () => {
  const rows = wash([
    ["青丘烘焙", "LINE：@demo_bakery；信箱：hello@example.com", "2025-09-08", "願意談", "迎新", "幹部B"],
    ["青丘烘焙　", "hello@example.com", "9/8", "已談過", "迎新", ""],
  ]);
  const events: ImportChoices = { ...EMPTY_CHOICES, eventByLabel: { 迎新: { kind: "existing", eventId: "E-0001" } } };

  it("「只留一筆」→ 留下資料比較完整的那筆，另一筆不匯入", () => {
    const choices: ImportChoices = { ...events, mergeDecisions: { "DUP-01": "同一筆紀錄重複，只留一筆" } };
    const review = reviewImport(rows, choices, context());
    assert.equal(review.rows.get(2)!.kept, true, "第 2 列有日期、負責人，比較完整");
    assert.equal(review.rows.get(2)!.action, "confirm");
    assert.equal(review.rows.get(3)!.kept, false);
    assert.equal(review.rows.get(3)!.action, "skip");
    assert.equal(review.plan.records.create.length, 1);
    assert.equal(review.plan.vendors.create.length, 1);
    const statuses = review.plan.staging.append.map((cells) => stagingCell(cells, "確認狀態"));
    assert.deepEqual(statuses, ["已寫入", "不匯入"]);
  });

  it("可以換成留另一筆", () => {
    const choices: ImportChoices = {
      ...events,
      mergeDecisions: { "DUP-01": "同一筆紀錄重複，只留一筆" },
      keepRow: { "DUP-01": 3 },
    };
    const review = reviewImport(rows, choices, context());
    assert.equal(review.rows.get(3)!.kept, true);
    assert.equal(review.rows.get(2)!.action, "skip");
  });

  it("選「同一廠商，往來紀錄都保留」但兩筆對到同一個活動 → ③只能一列，要改選只留一筆", () => {
    const choices: ImportChoices = { ...events, mergeDecisions: { "DUP-01": "同一廠商，往來紀錄都保留" } };
    const review = reviewImport(rows, choices, context());
    assert.equal(review.rows.get(2)!.writable, true);
    assert.ok(review.rows.get(3)!.blockers.some((blocker) => blocker.kind === "往來紀錄重複"));
  });

  it("「不同廠商，不合併」→ 各自是一家廠商", () => {
    const choices: ImportChoices = { ...events, mergeDecisions: { "DUP-01": "不同廠商，不合併" } };
    const review = reviewImport(rows, choices, context());
    assert.equal(review.plan.vendors.create.length, 2);
    assert.equal(review.plan.records.create.length, 2);
  });
});

describe("同廠商不同活動、窗口不一致", () => {
  const rows = wash(
    [
      ["全家", "窗口：王小姐；family@example.com", "2026/09/10", "未聯絡", "2026九月系迎新", "幹部A"],
      ["全家", "窗口：陳先生；family@example.com", "2024/12/01", "已拒絕", "2024耶誕舞會", "幹部C"],
    ],
    new Map([
      [2, { ...EMPTY_INTERPRETATION, contactPerson: "王小姐" }],
      [3, { ...EMPTY_INTERPRETATION, contactPerson: "陳先生" }],
    ]),
  );
  const choices: ImportChoices = {
    ...EMPTY_CHOICES,
    eventByLabel: {
      "2026九月系迎新": { kind: "existing", eventId: "E-0001" },
      "2024耶誕舞會": { kind: "history", name: "2024耶誕舞會" },
    },
    mergeDecisions: { "DUP-01": "同一廠商，往來紀錄都保留" },
  };

  it("沒選窗口就不能確認；選了之後①一家、③兩筆都掛同一個廠商", () => {
    const pending = reviewImport(rows, choices, context());
    assert.ok(pending.rows.get(2)!.blockers.some((blocker) => blocker.kind === "欄位不一致"));

    const chosen = { ...choices, fieldChoices: { "group:DUP-01": { 聯絡窗口: "王小姐" } } };
    const { plan } = reviewImport(rows, chosen, context());
    assert.equal(plan.vendors.create.length, 1);
    assert.equal(plan.vendors.create[0].聯絡窗口, "王小姐");
    assert.deepEqual(plan.records.create.map((record) => record.廠商ID), ["V-0001", "V-0001"]);
    assert.deepEqual(plan.records.create.map((record) => record.聯絡狀態), ["未聯絡", "已拒絕"]);
  });
});

describe("③往來紀錄的寫法", () => {
  it("舊狀態不能直接採用 → 待確認；原狀態和舊聯絡日期寫進合作備註", () => {
    const rows = wash([["戊商行", "wu@example.com", "2025/09/15", "沒回", "迎新", "幹部A"]]);
    const choices = confirm({ ...EMPTY_CHOICES, eventByLabel: { 迎新: { kind: "existing", eventId: "E-0001" } } }, 2);
    const [record] = reviewImport(rows, choices, context()).plan.records.create;
    assert.equal(record.聯絡狀態, "待確認");
    assert.equal(record.合作備註, "舊資料：2025-09-15 聯絡，原狀態：沒回");
    assert.equal(record.負責組員, "幹部A");
    assert.equal(record.廠商名稱, "", "③的廠商名稱由公式帶出");
  });

  it("「確認所有沒有問題的列」只會確認沒有問題的列", () => {
    const rows = wash([
      ["己商行", "ji@example.com", "", "未聯絡", "迎新", ""],
      ["庚商行", "", "", "未聯絡", "迎新", ""],
    ]);
    const choices: ImportChoices = { ...EMPTY_CHOICES, eventByLabel: { 迎新: { kind: "existing", eventId: "E-0001" } } };
    const next = confirmAllReady(reviewImport(rows, choices, context()), choices);
    assert.deepEqual(next.actions, { 2: "confirm" });
  });
});

describe("⑤待處理的列讀回來", () => {
  const golden = JSON.parse(
    readFileSync(new URL("./golden.json", import.meta.url), "utf8"),
  ) as { raw: string[][] };
  const [goldenHeaders, ...goldenRows] = golden.raw;
  const goldenMapping: ColumnMapping = {
    legacyId: [0],
    vendorName: [1],
    contact: [2],
    contactDate: [3],
    status: [4],
    sponsorship: [5],
    eventLabel: [6],
    owner: [7],
    notes: [8],
  };
  const { rows } = washTable({ headers: goldenHeaders, rows: goldenRows }, goldenMapping);

  it("Golden 12 筆存進⑤再讀回來，處置、狀態、聯絡方式都一樣", () => {
    for (const row of rows) {
      const back = fromStagingRow(toStagingRow(row, batch));
      assert.equal(back.stagingId, `${batch.batchId}-${row.rowNumber}`);
      assert.equal(back.vendorName, row.vendorName);
      assert.equal(back.email.value, row.email.value);
      assert.equal(back.email.check, row.email.check);
      assert.equal(back.contactMethod, row.contactMethod);
      assert.equal(back.date.iso, row.date.iso);
      assert.equal(back.date.check, row.date.check);
      assert.equal(back.status.label, row.status.label);
      assert.equal(back.vendorStopContact, row.vendorStopContact);
      assert.equal(back.contactValidity, row.contactValidity);
      // 疑似重複要跟這一批放在一起重新分組，所以單筆讀回來時不比對
      if (!row.duplicateGroup) assert.equal(back.disposition, row.disposition, `舊序 ${row.legacyId}`);
    }
  });

  it("讀回來的列處理完 → 更新⑤原本那一列，不新增", () => {
    const pending = fromStagingRow(toStagingRow(rows.find((row) => row.legacyId === "05")!, batch));
    const [reloaded] = regroupDuplicates([{ ...pending, rowNumber: 100 }]);
    const choices = confirm({ ...EMPTY_CHOICES, eventByLabel: { 運動會: { kind: "history", name: "運動會" } } }, 100);
    const { plan } = reviewImport([reloaded], choices, context());
    assert.equal(plan.staging.append.length, 0);
    assert.deepEqual(plan.staging.update, [
      {
        stagingId: `${batch.batchId}-6`,
        changes: { 確認狀態: "已寫入", 對應活動ID: "E-0002", 合併決定: "" },
      },
    ]);
  });
});
