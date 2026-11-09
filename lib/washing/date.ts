// 日期清洗：把舊資料裡各種寫法轉成 ISO 日期（YYYY-MM-DD）。
// 原則：看不出來就留空並標記，絕不猜年份、不改月份。

export type DateCheck =
  | "valid"
  | "missing" // 空白
  | "missing_year" // 例如 9/8
  | "ambiguous_year" // 例如 25/9/8，可能是西元或民國
  | "invalid" // 例如 2025/13/45
  | "unrecognized"; // 其他看不懂的寫法

export interface CleanDate {
  iso: string | null;
  check: DateCheck;
  note: string;
}

const ROC_OFFSET = 1911;
const MAX_ROC_YEAR = 200;

const FULL_DATE = /^(民國)?(\d{2,4})(?:[-/.]|年)(\d{1,2})(?:[-/.]|月)(\d{1,2})日?$/;
const NO_YEAR_DATE = /^(\d{1,2})(?:[-/.]|月)(\d{1,2})日?$/;

function toIso(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  const isRealDate =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  if (!isRealDate) return null;
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

export function cleanDate(raw: string): CleanDate {
  const text = raw.normalize("NFKC").replace(/\s+/g, "");

  if (text === "" || /^[-—–]+$/.test(text)) {
    return { iso: null, check: "missing", note: "日期缺漏" };
  }

  const full = FULL_DATE.exec(text);
  if (full) {
    const hasRocPrefix = full[1] !== undefined;
    const yearText = full[2];
    const month = Number(full[3]);
    const day = Number(full[4]);

    let year: number;
    if (hasRocPrefix) {
      if (yearText.length === 4) {
        return { iso: null, check: "unrecognized", note: `無法辨識的日期：${raw}` };
      }
      year = Number(yearText) + ROC_OFFSET;
    } else if (yearText.length === 4) {
      year = Number(yearText);
    } else if (yearText.length === 3) {
      if (Number(yearText) > MAX_ROC_YEAR) {
        return { iso: null, check: "invalid", note: `日期無效：${raw}` };
      }
      year = Number(yearText) + ROC_OFFSET;
    } else {
      return {
        iso: null,
        check: "ambiguous_year",
        note: `兩位數年份無法判斷西元或民國：${raw}`,
      };
    }

    const iso = toIso(year, month, day);
    if (iso === null) {
      return { iso: null, check: "invalid", note: `日期無效：${raw}` };
    }
    return { iso, check: "valid", note: "有效" };
  }

  const noYear = NO_YEAR_DATE.exec(text);
  if (noYear) {
    const month = Number(noYear[1]);
    const day = Number(noYear[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      return { iso: null, check: "invalid", note: `日期無效：${raw}` };
    }
    return { iso: null, check: "missing_year", note: `缺年份，不得推測：${raw}` };
  }

  return { iso: null, check: "unrecognized", note: `無法辨識的日期：${raw}` };
}
