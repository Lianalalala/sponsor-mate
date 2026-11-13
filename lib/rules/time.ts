const DAY_MS = 86_400_000;
const taipeiFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Taipei", calendar: "iso8601", numberingSystem: "latn",
  year: "numeric", month: "2-digit", day: "2-digit",
});

/** 明確的 ISO 時間，必須含秒及 Z／±HH:mm；拒絕 JS 會自動滾動的假日期。 */
export function parseInstant(value: string | null): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, m, d, h, min, s, , zone] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  if (year < 1000 || month < 1 || month > 12 || day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    Number(h) > 23 || Number(min) > 59 || Number(s) > 59) return null;
  if (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : null;
}

export function toTaipeiDate(value: string): string | null {
  const instant = parseInstant(value);
  if (instant === null) return null;
  const parts = taipeiFormatter.formatToParts(instant);
  const part = (name: string) => parts.find((p) => p.type === name)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** 日曆天差，非滿 24 小時；負數保留給呼叫端辨認未來日期。 */
export function calendarDaysBetween(earlier: string, later: string): number | null {
  const first = toTaipeiDate(earlier), last = toTaipeiDate(later);
  if (first === null || last === null) return null;
  return (Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / DAY_MS;
}
