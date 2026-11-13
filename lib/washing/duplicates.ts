// 找「疑似重複」的候選：同名、同 Email、名稱互相包含（D-023）。
// 這裡只負責分組、列出證據和建議是哪一種，合併一定要公關長決定，程式不做任何合併。

export interface DuplicateInput {
  id: number;
  vendorName: string | null;
  email: string | null;
}

/** 比對名稱時忽略大小寫與空白（含全形空白）；顯示時仍用原本的名稱 */
export function vendorNameKey(name: string): string {
  return name.replace(/\s+/g, "").toLowerCase();
}

/** 兩筆是不是可能同一家：同名、同 Email、名稱互相包含。這一批之間、跟①既有廠商比對都用這一條 */
export function looksLikeSameVendor(
  a: { vendorName: string | null; email: string | null },
  b: { vendorName: string | null; email: string | null },
): boolean {
  return isSuspectedDuplicate({ id: 0, ...a }, { id: 1, ...b });
}

function isSuspectedDuplicate(a: DuplicateInput, b: DuplicateInput): boolean {
  if (!a.vendorName || !b.vendorName) return false;
  const nameA = vendorNameKey(a.vendorName);
  const nameB = vendorNameKey(b.vendorName);
  if (nameA === nameB) return true;
  if (a.email && a.email === b.email) return true;
  return nameA.includes(nameB) || nameB.includes(nameA);
}

/** 回傳 id → 群組代號（DUP-01…）；沒有疑似重複的列不會出現 */
export function findDuplicateGroups(rows: DuplicateInput[]): Map<number, string> {
  const parent = rows.map((_, index) => index);

  function find(index: number): number {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  }

  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (isSuspectedDuplicate(rows[i], rows[j])) {
        parent[find(j)] = find(i);
      }
    }
  }

  const members = new Map<number, number[]>();
  rows.forEach((_, index) => {
    const root = find(index);
    members.set(root, [...(members.get(root) ?? []), index]);
  });

  const groups = new Map<number, string>();
  let groupNumber = 0;
  for (const indexes of members.values()) {
    if (indexes.length < 2) continue;
    groupNumber += 1;
    const code = `DUP-${String(groupNumber).padStart(2, "0")}`;
    for (const index of indexes) groups.set(rows[index].id, code);
  }
  return groups;
}

// ⑤「合併決定」下拉選單的選項（D-023）。空白＝公關長還沒決定。
export const MERGE_DECISIONS = [
  "同一廠商，往來紀錄都保留",
  "同一筆紀錄重複，只留一筆",
  "不同廠商，不合併",
] as const;

export type MergeDecision = (typeof MERGE_DECISIONS)[number];

export type DuplicateLevel = "廠商層級" | "往來紀錄層級" | "待公關長判斷";

/** 比對一組疑似重複需要的欄位；值都是清洗後的結果，空字串或 null 表示沒有資料 */
export interface DuplicateMember {
  id: number;
  vendorName: string | null;
  email: string | null;
  eventLabel: string;
  /** 只在名稱完全相同時比對，用來標出「同一家廠商但欄位不一致」 */
  compareFields: Record<string, string | null>;
  /** 名稱相同且活動也相同時才比對的欄位（日期、贊助內容） */
  sameEventFields: Record<string, string | null>;
}

export interface DuplicateAnalysis {
  group: string;
  level: DuplicateLevel;
  /** 程式的建議；名稱不完全相同時一律是 null，不替公關長選 */
  suggestion: MergeDecision | null;
  /** 判斷依據，例如「名稱相同（青丘烘焙）」「Email 相同」 */
  evidence: string[];
  /** 名稱相同但值不一樣的欄位；不挑哪一個對，每筆保留自己的值 */
  mismatchedFields: string[];
}

function distinct(values: (string | null)[]): string[] {
  return [...new Set(values.map((value) => (value ?? "").trim()).filter((value) => value !== ""))];
}

function describe(label: string, values: string[], total: number): string {
  if (values.length === 0) return `${label}都沒有資料`;
  if (values.length === 1) {
    return total > 1 ? `${label}相同（${values[0]}）` : `${label}只有一筆有資料（${values[0]}）`;
  }
  return `${label}不同（${values.join("／")}）`;
}

function mismatches(members: DuplicateMember[], pick: (member: DuplicateMember) => Record<string, string | null>): string[] {
  const labels = Object.keys(pick(members[0]));
  return labels.filter((label) => distinct(members.map((member) => pick(member)[label])).length > 1);
}

/**
 * 分析一組疑似重複，建議是哪一種（D-023）：
 * - 名稱完全相同、活動都不同 → 廠商層級，建議「同一廠商，往來紀錄都保留」
 * - 名稱完全相同、活動也相同 → 往來紀錄層級，建議「同一筆紀錄重複，只留一筆」
 * - 名稱不完全相同，或活動有同有不同 → 不建議，只列證據，由公關長決定
 */
export function analyzeDuplicateGroup(group: string, members: DuplicateMember[]): DuplicateAnalysis {
  const names = distinct(members.map((member) => member.vendorName));
  const nameKeys = new Set(names.map(vendorNameKey));
  const emails = distinct(members.map((member) => member.email));
  const events = distinct(members.map((member) => member.eventLabel));
  const emailCount = members.filter((member) => member.email).length;
  const eventCount = members.filter((member) => member.eventLabel.trim()).length;

  const sameName = nameKeys.size === 1;
  const evidence = [
    sameName ? `名稱相同（${names[0]}）` : `名稱不完全相同（${names.join("／")}）`,
    describe("Email ", emails, emailCount),
    describe("活動", events, eventCount),
  ];

  if (!sameName) {
    evidence.push("名稱不完全相同，可能是同一家，也可能是不同分店或不同廠商");
    return { group, level: "待公關長判斷", suggestion: null, evidence, mismatchedFields: [] };
  }

  const allSameEvent = events.length === 1 && eventCount === members.length;
  const allDifferentEvents = events.length === members.length;
  const mismatchedFields = mismatches(members, (member) => member.compareFields);

  if (allSameEvent) {
    mismatchedFields.push(...mismatches(members, (member) => member.sameEventFields));
    return {
      group,
      level: "往來紀錄層級",
      suggestion: "同一筆紀錄重複，只留一筆",
      evidence,
      mismatchedFields,
    };
  }
  if (allDifferentEvents) {
    return {
      group,
      level: "廠商層級",
      suggestion: "同一廠商，往來紀錄都保留",
      evidence,
      mismatchedFields,
    };
  }
  evidence.push("有些筆活動相同、有些不同，請公關長決定");
  return { group, level: "待公關長判斷", suggestion: null, evidence, mismatchedFields };
}
