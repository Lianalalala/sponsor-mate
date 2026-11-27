# E01／E02 外寄守門核心

依 [Decision Log](https://app.notion.com/p/3f42685d187981d48ab0c18c2caffeea)、
[系統架構](https://app.notion.com/p/3f42685d1879816e8378dd53a127cb8b) 與
[E01／E02 驗收清單](https://app.notion.com/p/4092685d187981d499cad5745dda1646)，
集中核對「有效逐封人工核准」及「廠商停止聯絡」兩項必要條件。

`evaluateSendGuards(input)` 是供可信伺服器接線與 Node 離線測試使用的純函式，
不讀環境變數、不驗證 Session、不查資料庫、不發 HTTP、不寄送或保存資料。
目前沒有正式 adapter、公開 API、Server Action 或 server-only 匯出入口。
正式接線必須經伺服器專用邊界，不能把前端執行此函式當成授權控制。

## 輸入契約

| 輸入 | 必須由後端提供的資料 |
| --- | --- |
| `actor` | 驗證 Session 及目前成員資格後的 id、clubId、明確的 `canSend` 能力；未登入用 null |
| `draft` | 目前版本的完整 `ReviewDraft`，包含社團、收件人、主旨、正文、附件與版本 |
| `review` | 可信儲存層載入的該封信審核紀錄；未送審用 null，不能採用 request body 自製的已核准物件 |
| `vendor` | 同社團①廠商主檔的 vendorId、clubId、資料 revision 及 `Confirmed<boolean>` 停止聯絡資料 |

`canSend` 是正式權限系統驗證後的能力，不從 `canApprove` 或角色名稱推測。
本核心不決定哪種角色可以寄送；也不新增核准有效天數、自審禁止或停止聯絡的例外。
額外的 `approved`、頂層 `canSend`、`preSendResult` 等旗標不參與判斷。

**型別、confirmed 或能力值不是來源認證。** 結構完全合法的偽造資料，純函式無法辨識其來源。
正式入口必須自行驗證身分、依登入者社團查詢資料，不能直接把請求 body 當成此函式的輸入。
活動及附件的歸屬也須由 loader 檢查，不能只依草稿上自報的社團。

## 檢查順序

1. 身分、寄送能力、草稿識別及社團歸屬不完整或不符時，立即阻擋。
2. 廠商資料若屬於其他社團或其他廠商，不採用該筆停止聯絡旗標。
3. E01 重用 `mail-review.reconcileReview`，核對完整快照、草稿版本與審核紀錄。
   只有仍為 `approved` 才通過；待審核、失效、缺漏或不合法紀錄都阻擋。
   不重寫既有快照比較、時間檢查及修改失效規則。
4. E02 只接受已確認且為 boolean 的主檔資料：true 阻擋；false 才符合此項條件。
   未確認、缺版本、null、字串「否」、讀不到廠商等都不能當 false。
   這項限制不依活動或外寄類型分支，適用首次邀約、催信及其他外寄。
   ③「停止追蹤／已拒絕」及⑤暫存不是①的停止聯絡旗標，不在此另訂 E03 例外。

回傳失敗原因只含固定代碼，不包含完整信件、收件人、核准快照或原始例外。
可能同時回報 E01 與 E02；身分或歸屬不符則先阻擋，不回傳其他社團資料。
結果及其 finding／binding 均凍結，不修改輸入，也不保存失效審核紀錄。

## 回傳範圍

- `status: "blocked"`：`findings` 的 code 為 `access／data／E01／E02`，附固定 reason。
- `status: "guards_passed"`：僅 E01／E02 對目前輸入通過，附
  `clubId／draftId／draftRevision／vendorId／vendorRevision` 綁定。
- 兩者皆標記 `scope: "E01_E02_only"`，**不是最終 canSend 或可重放的寄送許可**。

既有 `checkPreSend` 仍須針對最新收件人、廠商、活動、附件及連結證據執行；
這兩項守門通過不表示新的窗口、企劃書或其他資料已通過完整檢核。
催信候選 `recommended`、寄前 `pass` 與 Sheets 的「已核准」文字都不能代替可信的逐封核准。
收到的人工補登回覆不執行外寄，本核心不處理補登流程。

## 最新資料與失效生命週期

- 每次準備寄送都須重新取得目前草稿、可信審核紀錄及①停止聯絡資料，不沿用前端快取的通過結果。
  loader 讀取失敗時，正式入口應拒絕請求；不能回退到預設 false 或舊的通過結果。
- 每次編輯須換成未用過的新 revision，並由 DAL 保存 `reconcileReview` 的失效結果與歷史。
  此守門函式只核對當下輸入，不能察覺呼叫端漏存的中間修改。
  保存為 invalidated 的紀錄即使還原舊內容也不恢復核准；舊 approval 只供追溯。
- 版本綁定便於後續核對，但無法證明資料來源最新，也無法鎖住檢查後的修改。
  停止聯絡由否改為是後，必須用新的主檔資料再檢查，不能沿用原先 guards_passed。
- 正式流程仍須處理版本競爭、完整最終寄件內容、每日額度原子保留、寄送重入、
  未決寄件與結果保存；不能宣稱此純函式已完成伺服器端最終寄送許可。

## 離線測試與後續驗收

`__tests__/guards.test.ts` 使用既有送審／核准函式建立虛構紀錄，
涵蓋缺少核准、修改後失效、還原文字、停止聯絡更新、外寄類型、資料未知、
角色能力、跨社團／跨廠商、前端自報旗標及與 pre-send 的組合邊界。
不呼叫 AI、Google、Neon，也不讀取 .env.local。

```powershell
node --test lib/mail-send/__tests__/guards.test.ts
npm.cmd test
npx.cmd --no-install tsc --noEmit --incremental false
npx.cmd --no-install eslint lib/mail-send/guards.ts lib/mail-send/__tests__/guards.test.ts
```

正式寄送入口接上後，還須驗收：後端實際載入最新可信資料、沒有繞過檢查的寄送路徑、
E01／E02 阻擋時模擬寄件器零呼叫，以及檢查到寄送之間資料更新的競爭處理。
單元測試通過不代表 E01／E02 的伺服器整合或 E2E 已驗收。
