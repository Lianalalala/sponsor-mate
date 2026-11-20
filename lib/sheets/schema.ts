// 依使用者確認的資料表骨架：欄位只引用既有定義，④在此保留唯一清單。
import { VENDOR_COLUMNS, EVENT_COLUMNS, RECORD_COLUMNS, HISTORY_EVENT_STATUS } from "../washing/write-plan.ts";
import { STAGING_COLUMNS, CONFIRM_STATUSES } from "../washing/staging.ts";
import { CONTACT_METHODS } from "../washing/contact.ts";
import { MERGE_DECISIONS } from "../washing/duplicates.ts";

export const SHEET_NAMES = Object.freeze({
  vendors: "1. 廠商",
  events: "2. 活動",
  records: "3. 往來紀錄",
  mails: "4. 信件紀錄",
  staging: "5. 舊資料暫存",
} as const);

// 空格及「核准版本旨文」均保留骨架原文，不在此修正命名。
export const MAIL_COLUMNS = [
  "信件 ID",
  "往來 ID",
  "活動 ID",
  "信件方向",
  "信件類型",
  "對方 Email",
  "主旨",
  "內容摘要",
  "完整內容版本參照",
  "附件檔名",
  "附件參照",
  "附件版本",
  "審核狀態",
  "核准版本旨文",
  "核准人",
  "核准時間",
  "寄送狀態",
  "寄送時間",
  "Gmail Message ID",
  "錯誤摘要",
  "寄送操作人",
  "建立人",
  "建立時間",
  "最後更新人",
  "最後更新時間",
] as const;

export const EVENT_STATUSES = ["籌備中", "招商中", "已結束", HISTORY_EVENT_STATUS] as const;
export const RECORD_CONTACT_STATUSES = [
  "未聯絡", "已寄出・尚未回覆", "已回覆・待處理", "洽談中", "已同意合作", "已拒絕", "待確認",
] as const;
export const RECORD_PROCESSING_DECISIONS = ["繼續追蹤", "停止追蹤", "停止追蹤（限該活動）", "待確認"] as const;
export const MAIL_DIRECTIONS = ["寄出", "收到（人工補登）"] as const;
export const MAIL_KINDS = ["首次邀約", "催信", "其他外寄", "回覆補登"] as const;
export const MAIL_REVIEW_STATUSES = ["未送審", "待審核", "已核准", "已退回", "不適用"] as const;
// Sheets 用字與規則引擎內部的「不適用（補登回覆）」不同，之後由 DAL 明確轉換。
export const MAIL_SEND_STATUSES = ["未寄送", "寄送中", "成功", "失敗", "待確認", "不適用"] as const;

export interface SheetDefinition {
  readonly sheetId: number;
  readonly title: string;
  readonly columns: readonly string[];
  readonly notes: Readonly<Record<string, string>>;
  readonly dropdowns: readonly { readonly column: string; readonly values: readonly string[] }[];
}

function defineSheet<const Columns extends readonly string[]>(
  sheetId: number,
  title: string,
  columns: Columns,
  notes: Readonly<Record<Columns[number], string>>,
  dropdowns: readonly { readonly column: Columns[number]; readonly values: readonly string[] }[],
): SheetDefinition {
  return Object.freeze({ sheetId, title, columns, notes: Object.freeze(notes), dropdowns });
}

// 說明按欄名對應；實際列順序一律由 columns 決定，型別檢查會擋下漏欄或多欄。
export const SHEET_DEFINITIONS: readonly SheetDefinition[] = Object.freeze([
  defineSheet(0, SHEET_NAMES.vendors, VENDOR_COLUMNS, {
    "廠商ID": "必填｜系統產生",
    "廠商名稱": "必填",
    "產業類別": "選填",
    "聯絡窗口": "選填｜換人直接改，舊窗口寫進備註",
    "窗口職稱": "選填",
    "主要聯絡方式": "必填｜下拉選單；空白＝待確認",
    "主要聯絡資訊": "主要聯絡方式不是 Email 時必填｜LINE ID、粉專網址、官網表單連結、電話號碼等",
    "Email": "主要聯絡方式＝Email 時必填｜寄前檢核會查格式",
    "電話": "選填",
    "其他聯絡管道": "選填｜幹部整理後填，不擷取私人對話",
    "聯絡備註": "選填｜聯絡相關的補充，例如只在平日回覆",
    "廠商主動要求停止聯絡": "必填｜預設「否」",
    "備註": "選填｜舊窗口、停止聯絡的原因與日期寫這裡",
    "資料來源": "系統填｜手動新增／Excel 匯入／Picker",
    "最後更新時間": "系統填",
    "最後更新人": "系統填",
  }, [
    { column: "主要聯絡方式", values: CONTACT_METHODS },
  ]),
  defineSheet(1, SHEET_NAMES.events, EVENT_COLUMNS, {
    "活動ID": "必填｜系統產生",
    "活動名稱": "必填",
    "活動日期": "必填｜草稿帶入｜歷史活動可留空",
    "招商截止日": "選填｜過了就不再建議催信",
    "活動簡介": "選填｜草稿帶入",
    "合作需求": "選填｜草稿帶入",
    "企劃書版本": "必填｜只記最新版，舊版看④信件紀錄｜歷史活動可留空",
    "企劃書連結": "必填｜寄前檢核查連結｜歷史活動可留空",
    "活動狀態": "必填｜下拉選單：籌備中／招商中／已結束／歷史（歷史＝匯入舊資料時建立的過去活動）",
    "資料來源": "系統填",
    "最後更新時間": "系統填",
    "最後更新人": "系統填",
  }, [
    { column: "活動狀態", values: EVENT_STATUSES },
  ]),
  defineSheet(2, SHEET_NAMES.records, RECORD_COLUMNS, {
    "往來ID": "必填｜系統產生",
    "廠商ID": "必填｜同一組廠商＋活動只能一列",
    "廠商名稱": "自動帶出（公式）",
    "活動ID": "必填",
    "活動名稱": "自動帶出（公式）",
    "負責組員": "選填（待確認要不要）",
    "聯絡狀態": "必填｜下拉選單｜舊資料狀態無法直接採用時為待確認，原狀態寫合作備註",
    "處理決策": "必填｜下拉選單｜停止原因寫合作備註",
    "寄信次數": "自動計算｜數④已寄出的信（待確認，④定案後加公式）",
    "最後寄信時間": "自動計算｜同上",
    "合作備註": "選填",
    "合作承諾": "選填｜結案預留",
    "成果連結": "選填｜結案預留",
    "待補資料": "選填｜結案預留",
    "資料來源": "系統填",
    "最後更新時間": "系統填",
    "最後更新人": "系統填",
    "現金金額（NTD）": "選填｜合作承諾的金額，不代表已到款",
    "實物品項": "選填",
    "實物數量": "選填｜不確定的數量留空",
    "單位": "選填",
  }, [
    { column: "聯絡狀態", values: RECORD_CONTACT_STATUSES },
    { column: "處理決策", values: RECORD_PROCESSING_DECISIONS },
  ]),
  defineSheet(3, SHEET_NAMES.mails, MAIL_COLUMNS, {
    "信件 ID": "必填｜系統產生，每封信／補登回覆各一列",
    "往來 ID": "必填｜連結③往來紀錄的往來ID",
    "活動 ID": "自動帶出｜由往來ID連結③的活動ID，供活動篩選",
    "信件方向": "必填｜寄出／收到（人工補登）",
    "信件類型": "必填｜首次邀約／催信／其他外寄／回覆補登",
    "對方 Email": "寄出必填｜收件地址；補登回覆為對方 Email（若已知）",
    "主旨": "寄出必填｜核准與寄送時使用的主旨",
    "內容摘要": "選填｜摘要供搜尋、交接；不等於完整原文",
    "完整內容版本參照": "草稿及已核准寄出信件需有受控版本參照｜不將完整正文直接放入 Sheets；儲存機制待實作",
    "附件檔名": "有附件時必填｜寄送的 PDF 檔名",
    "附件參照": "有附件時必填｜檔案識別／受控儲存參照；不貼公開敏感連結",
    "附件版本": "有附件時必填｜寄出當時鎖定的檔案版本",
    "審核狀態": "必填｜未送審／待審核／已核准／已退回／不適用（補登回覆）",
    "核准版本旨文": "核准後系統產生｜正文、主旨、收件人、附件版本的版本旨文；變更須重新審核（後端待實作）",
    "核准人": "已核准必填｜核准操作人由系統紀錄",
    "核准時間": "已核准必填｜核准時間由系統紀錄",
    "寄送狀態": "必填｜未寄送／寄送中／成功／失敗／待確認／不適用（補登回覆）",
    "寄送時間": "寄送成功由系統紀錄｜補登回覆不適用",
    "Gmail Message ID": "寄送成功由 Gmail API 回傳｜避免重複寄送的識別之一",
    "錯誤摘要": "寄送失敗或結果不明才填｜不得含金鑰或完整信件",
    "寄送操作人": "實際發送時由系統紀錄｜補登回覆不適用",
    "建立人": "系統填｜建立操作人",
    "建立時間": "系統填｜建立時間",
    "最後更新人": "系統填｜最後修改操作人",
    "最後更新時間": "系統填｜最後修改時間",
  }, [
    { column: "信件方向", values: MAIL_DIRECTIONS },
    { column: "信件類型", values: MAIL_KINDS },
    { column: "審核狀態", values: MAIL_REVIEW_STATUSES },
    { column: "寄送狀態", values: MAIL_SEND_STATUSES },
  ]),
  defineSheet(4, SHEET_NAMES.staging, STAGING_COLUMNS, {
    "暫存ID": "系統產生｜批次＋列號",
    "匯入批次": "系統填｜同一次匯入同一批",
    "來源檔名": "系統填",
    "原始列號": "系統填｜可追溯回舊表",
    "舊序": "舊表原值",
    "匯入處置": "系統填｜可暫存、可暫存／禁止聯絡、待人工覆核、阻擋正式匯入",
    "待確認原因": "系統填｜給公關長看的理由",
    "廠商名稱": "系統整理｜可修改",
    "主要聯絡方式": "系統判斷｜有效 Email 直接選 Email，沒有才由 AI 判斷；空白＝待確認",
    "主要聯絡資訊": "系統整理｜主要聯絡方式不是 Email 時填，必須在原文找得到",
    "Email": "系統整理｜格式無效時留空，不補造",
    "Email檢核": "系統填",
    "聯絡窗口": "AI 拆解｜原文找不到的會捨棄",
    "窗口有效性": "系統填｜舊窗口不得直接使用",
    "其他聯絡管道": "AI 拆解",
    "聯絡備註": "AI 拆解｜聯絡相關的補充說明",
    "聯絡日期": "系統整理｜看不出來就留空，不猜年份",
    "日期檢核": "系統填",
    "舊活動標籤": "舊表原文｜不自動對應現行活動",
    "對應活動ID": "公關長填｜對應②的活動 ID",
    "聯絡狀態候選": "系統填｜不確定時為待釐清",
    "狀態可直接採用": "系統填｜是／否",
    "處理決策候選": "系統填",
    "廠商停止聯絡": "系統填｜是：進①時寫入停止聯絡",
    "現金金額（NTD）": "AI 拆解｜舊資料不代表已到款",
    "實物品項": "AI 拆解",
    "實物數量": "AI 拆解｜不確定的數量留空",
    "單位": "AI 拆解",
    "疑似重複群組": "系統填｜合併一定要公關長確認",
    "合併決定": "公關長在 /import 預覽頁選｜下拉選單；不屬於疑似重複群組時留空",
    "原負責人": "舊表原值",
    "原始資料": "系統填｜整列原文（JSON）",
    "確認狀態": "系統填｜下拉選單：已寫入／待處理／不匯入；待處理的列下次開 /import 會讀回來",
    "建立時間": "系統填",
    "建立人": "系統填",
  }, [
    { column: "合併決定", values: MERGE_DECISIONS },
    { column: "確認狀態", values: CONFIRM_STATUSES },
  ]),
]);
