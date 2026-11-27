# Sheets 讀寫底層

對應 Notion「Sheets 讀寫（資料存取層 Data Access Layer）」：
https://app.notion.com/p/3fb2685d187981b199e0cf6a5a3c0bd8

這是尚未接上網頁的內部 HTTP 元件，不代表 Sheets DAL 任務已完成。
應用程式從 `lib/sheets/index.ts` 匯入；`server-only` 防止該入口進入 Client Component。
`transport.ts` 是供入口和離線測試使用的內部實作，不能由前端匯入。

- `readValues(range)`：讀取 A1 範圍，保留中間空列與 Google 回傳的儲存格型別。
- `appendRows(range, rows)`：以 `RAW`、`INSERT_ROWS` 新增，不把 `=...` 舊資料當公式。
- 每次呼叫重新取得 access token；停用快取，不自動重試，不回傳憑證或 Google 錯誤內文。
- 寫入超時、連線中斷、5xx 或成功回應不完整時，回報 `writeOutcome: "unknown"`；
  先核對實際結果，不能直接重送。這不構成去重或跨請求的重入保護。

## 建立社團資料庫試算表（D-013）

`createClubSpreadsheet(accessToken, clubName): Promise<string>` 接收呼叫端提供的社團 access token
與社團名稱，成功完成建表及初始化後回傳 `spreadsheetId`。
從 `lib/sheets/index.ts` 的 `server-only` 入口匯入；`create-spreadsheet.ts` 是入口與離線測試專用內部實作。

```ts
import { createClubSpreadsheet } from "@/lib/sheets";

// 呼叫端先驗證 session、公關長權限及社團 OAuth；不要把實際 token 寫進程式。
const spreadsheetId = await createClubSpreadsheet(accessToken, clubName);
// 之後由呼叫端依社團綁定保存 spreadsheetId，本函式不寫 Neon。
```

- 使用原生 fetch，不增加套件；不讀環境變數、不自行取得／更新 token、不連接資料庫。
  呼叫端須提供授權社團帳號的 token（`drive.file`），不能直接信任前端上傳的 token 或社團綁定。
  此函式沒有公開 API／Server Action，也不會驗證 Google 帳號是否屬於該社團。
- 第一次 POST `spreadsheets.create`，建立 `${clubName}｜sponsor-mate 資料庫`，
  使用 `zh_TW`、`Asia/Taipei`，五頁各先配置 1000 列並凍結前兩列。
- 第二次 POST `spreadsheets/{id}:batchUpdate`，同一批次寫入第 1 列標題、第 2 列說明及資料區下拉；
  第 3 列起留空。所有儲存格使用 `stringValue`，不建立公式，也不預填整欄「否」。
- 成功時回傳 ID；不自動移動檔案、變更分享、重試、刪檔或建立第二份試算表。
  檔案所屬帳號由傳入 token 決定，呼叫端負責確認使用社團 OAuth。

`schema.ts` 集中定義正式分頁名稱、④欄位、說明與已確認的下拉：

| 分頁名稱 | 欄位來源 | 欄數 | 下拉欄 |
| --- | --- | --- | --- |
| `1. 廠商` | `VENDOR_COLUMNS`（沿用 `washing/write-plan.ts`） | 16 | F |
| `2. 活動` | `EVENT_COLUMNS`（同上） | 12 | I |
| `3. 往來紀錄` | `RECORD_COLUMNS`（同上） | 21 | G、H |
| `4. 信件紀錄` | `MAIL_COLUMNS`（`schema.ts` 唯一定義） | 25 | D、E、M、Q |
| `5. 舊資料暫存` | `STAGING_COLUMNS`（沿用 `washing/staging.ts`） | 35 | AD、AG |

既有①②③⑤不另外抄欄位清單；說明以欄名對應，輸出順序仍由各欄位常數決定。
④保留 ID 標題中的空格及 N 欄原文「核准版本旨文」。`SHEET_NAMES` 也供⑤讀取共用，
舊測試表的 `①廠商` 等名稱不作為實際建立名稱。

①產業類別／資料來源／停止聯絡，以及⑤主要聯絡方式／匯入處置，本次不額外設定下拉。
⑤ Email檢核、日期檢核、聯絡狀態候選仍可保存系統說明文字。
④下拉採使用者確認的選項；「不適用」與規則引擎內部的「不適用（補登回覆）」需由未來 DAL 明確轉換。
審核核心 `invalidated` 也不能自動當成④的「已退回」；本次不更動這些核心規則。

### 建立失敗與半成品

`SpreadsheetCreationError` 沿用 `SheetsError` 的 `code`、`writeOutcome`、`status`，
另提供 `stage: "create" | "initialize"` 及已知時的 `spreadsheetId`。
`writeOutcome` 表示失敗階段的寫入結果，不表示整個建表流程已回復原狀。
初始化失敗時試算表可能已存在；不要直接再次呼叫建立函式。
呼叫端應妥善保存已知 ID、回報未完成並人工核對。建立請求斷線時也可能已建立檔案，
即使沒有取得 ID 都不能假設未建立。跨請求去重、併發與一次性初始化狀態由 Liana 的整合層處理。
錯誤不包含 token、社團名稱、Google 回應內文或原始例外；不要將完整請求或憑證記入日誌。

### 暫不建立的公式

| 位置 | 用途 |
| --- | --- |
| ③ C 廠商名稱 | 依廠商ID查① |
| ③ E 活動名稱 | 依活動ID查② |
| ③ I 寄信次數 | 依往來ID統計④成功外寄 |
| ③ J 最後寄信時間 | 依往來ID取得④成功外寄的最新時間 |
| ④ C 活動 ID | 依往來ID查③的活動ID |

本次上述資料列全部留空。舊測試表計次公式只比對寄出與成功，沒有驗證 Gmail Message ID，
不能直接當作最新規則引擎的完整成功證據。舊公式不複製，後續整合另行討論。

建表測試全部模擬 HTTP，檢查兩階段流程、欄位／說明、下拉範圍、⑤相容性與失敗結果；
沒有實際建立 Google 檔案，也沒有修改作為參考的兩份骨架。

Google 官方 API 參考：

- https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/create
- https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate
- https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/request#SetDataValidationRequest

## ⑤欄位核對

`assertStagingHeaders(headers)` 會依 `STAGING_COLUMNS` 核對標題列的欄數、名稱與順序。
缺欄、多欄、重複欄位、順序不同、名稱前後多出空白或欄名不是文字時，會拋出
`SheetsError`（`code: "schema_mismatch"`、`writeOutcome: "not_attempted"`）。
錯誤不保留原始儲存格內容，也不自動修正或重新排列欄位。

DAL 取得已授權的 Sheets client 後，應先讀完整第一列（`'5. 舊資料暫存'!1:1`），
以偵測 `AI` 之後多出的欄位，再進行核對：

```ts
import { assertStagingHeaders } from "@/lib/sheets";

// sheets 是 DAL 完成授權後建立的 client。
const headerRows = await sheets.readValues("'5. 舊資料暫存'!1:1");
assertStagingHeaders(headerRows[0]);
```

這是供未來 DAL 使用的離線檢查函式，目前尚未接上網頁或實際寫入流程。
呼叫端仍須在讀寫資料列前執行核對，並處理授權、版本檢查與併發控制。

## ⑤內部唯讀

`readStagingRows(sheets)` 接受已完成授權的 Sheets client，只讀取固定的⑤分頁。
使用單次 `readValues("'5. 舊資料暫存'")` 回應中的標題與資料進行核對，
不分成先讀標題、再讀資料的兩次請求；完整分頁範圍也可偵測 `AI` 後多出的欄位。

- 標題須符合現有 35 欄規格；資料列超過 35 欄時，回報第一個異常列的
  `StagingColumnCountError`，保留 `schema_mismatch` 錯誤代碼並暫停本次讀取。
  錯誤額外提供 `rowNumber`、`expectedColumns`、`actualColumns`，例如
  「⑤舊資料暫存第 5 列有 36 欄，預期 35 欄，請核對試算表。」；不包含儲存格內容。
- 排除第 1 列標題與第 2 列說明，從第 3 列開始回傳 `{ rowNumber, values }`。
- 保留中間空列、實際列號、儲存格型別及 Google 省略尾端空白格的形式。
  `values` 是副本，後續編輯不會改動原始回應。
- HTTP 讀取失敗會傳遞既有錯誤，不當作空資料表，也不自動重試或寫入。

此函式提供內部未篩選的原始列；只取「待處理」紀錄時，可使用下方的 `readPendingStagingRows`。
社團 OAuth、session／社團／角色驗證、說明列內容與版本檢查及併發控制仍待串接。
一次讀取的回應不代表已取得鎖定或完成版本檢查。⑤含原始資料，呼叫端不得直接將完整回應
公開給一般成員；應從 `lib/sheets/index.ts` 的 `server-only` 入口使用。

## ⑤待處理資料讀回

`readPendingStagingRows(sheets)` 沿用上述唯讀與整表欄位檢查，僅回傳「確認狀態」
完全等於「待處理」的列（D-025）。「已寫入」「不匯入」、空白或不明狀態不會自動視為待處理。

回傳仍是 `{ rowNumber, values }`：保留實際試算表列號、暫存ID、原始資料及儲存格內容，
不重編列號或改寫狀態。僅發出一次讀取；標題、欄數或 HTTP 發生錯誤時，傳遞既有錯誤，
不以空清單或部分資料掩蓋失敗。

這一步只篩選原始列，尚未呼叫 `fromStagingRow` 解碼、重新分組、接上網頁或寫回資料。
社團 OAuth、session／社團／角色授權及版本檢查等仍依上述要求由 DAL 完成。

## 尚待串接

接上公開 API 前必須完成：

1. 驗證 session，依 D-020／D-021 從伺服器查出社團、角色和已授權的試算表綁定。
   `spreadsheetId`、token 來源不可直接採用前端輸入；個人登入 token 不能當社團授權。
2. 社團 OAuth 提供有效的 access token；refresh token 安全保存與加密須依團隊決策實作。
3. 依 D-024／D-025 核對⑤的 35 欄（`A:AI`），欄位順序以 `lib/washing/staging.ts` 的
   `STAGING_COLUMNS` 為準；第 1 列是標題、第 2 列是說明，實際資料從第 3 列開始。
   成員不得取得⑤的完整原始資料；匯入僅開放公關長。
4. 依 D-025，公關長在 `/import` 預覽頁確認一次後，確認的列寫入①③；需要建立歷史活動時
   也寫入②。每列都在⑤留底，確認狀態為「已寫入／待處理／不匯入」；待處理的列下次讀回
   預覽頁繼續處理，不在⑤另做一次人工確認。現有 `lib/washing/write-plan.ts` 只產生寫入計畫，
   尚未接上實際 Sheets 寫入。
5. 為匯入批次實作持久化去重、併發控制、結果記錄與版本檢查。
   正式寫入①／③還需重新檢查停止聯絡、重複、活動對應與人工合併決定。

測試使用假的 HTTP 回應及虛構資料，不載入 `.env.local`、不連 Google、不呼叫 AI。
尚未用真實 OAuth／測試社團試算表驗證；既有 Golden Dataset 沒有被寫入。

Google 官方 API 參考：

- https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get
- https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/append
- https://developers.google.com/workspace/sheets/api/guides/concepts#cell
