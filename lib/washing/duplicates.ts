// 找「疑似重複」的候選：同名、同 Email、名稱互相包含。
// 這裡只負責分組提示，合併一定要幹部確認，程式不做任何合併。

export interface DuplicateInput {
  id: number;
  vendorName: string | null;
  email: string | null;
}

function isSuspectedDuplicate(a: DuplicateInput, b: DuplicateInput): boolean {
  if (!a.vendorName || !b.vendorName) return false;
  if (a.vendorName === b.vendorName) return true;
  if (a.email && a.email === b.email) return true;
  return a.vendorName.includes(b.vendorName) || b.vendorName.includes(a.vendorName);
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
