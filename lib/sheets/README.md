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
