# 寄前檢核：結構化資料純函式

依據系統架構的寄信模組與 D-004；本版採用暫定 MVP 規格，不新增正式產品決策。

- https://app.notion.com/p/3f42685d1879816e8378dd53a127cb8b
- https://app.notion.com/p/3f42685d187981d48ab0c18c2caffeea
- https://app.notion.com/p/3fb2685d187981388640d2231296a16d

## 使用範圍與安全邊界

本次只檢查「結構化寄件資料」，不是最終信件正文的完整驗證。

- AI 生成的正文是否使用正確資料，尚待草稿與審核流程整合。
- 最終收件人、主旨、正文、附件及版本，必須在實際寄送前重新核對。
- 人工確認證據不能由不可信任的前端欄位單獨決定是否通過。
- 後續人工審核需記錄確認人、時間與信件版本，資料變更後須重新核對。
- `checkPreSend()` 通過不代表完成逐封人工核准，也不代表允許寄信。
- 本階段不提供任何實際呼叫 Gmail API 的程式，也不讀取信箱。

此模組沒有網路、AI、Sheets、Neon、OAuth、登入或環境變數操作，不讀系統現在時間。
僅重用 main 上已存在的 `lib/rules/time.ts` 純函式 `parseInstant()` 驗證日期／證據時間，
不依賴 PR #2 的 history 修正、不修改既有模組，也不新增套件。

## 輸入契約

從 `lib/pre-send/index.ts` 匯入函式及型別。所有輸入為唯讀，函式不修改資料。

| 輸入 | 用途 |
| --- | --- |
| `draft` | 信件 ID／版本、完整 To／Cc／Bcc、所選窗口、廠商／活動、附件及連結清單 |
| `references` | 由可信來源載入的基準版本與已確認的窗口／廠商／活動；可為 null 表示缺少基準 |
| `policy` | 額外活動必填欄位、附件需求與指定檔案／版本、是否必須附連結 |
| `evidence` | 後端驗證、載入的人工確認紀錄；沒有可信證據時傳 null 或標為 untrusted |

`Confirmed.status` 與 `evidence.source: trusted_server` 是資料契約，**不是認證機制**。
純函式無法判定呼叫者是否在說實話。接線時必須由伺服器驗證操作者、
查得基準與確認紀錄後組裝參數，不能將請求 body 裡自報 trusted_server 的資料直接傳入。
本版不提供能繞過已知錯誤的通用 `humanApproved` 旗標。

基準物件即使標記 confirmed，仍須具備有效的必要欄位；缺少或無效基準不得默認通過。
空陣列表示明確沒有資料，不能用缺少陣列代表沒有 Cc、Bcc、附件或連結。

## 暫定 MVP 規則

1. **收件人**：只支援單一 To；Cc、Bcc、多位 To 或逗號／分號地址清單明確阻擋。
   Email 僅接受單純 ASCII 格式；不從顯示名稱或混合文字擷取。僅去首尾空白並統一網域大小寫，
   不改 local-part 大小寫、不刪 +tag 或點，不驗證信箱存在性。須符合有效且已確認的窗口及廠商關聯。
2. **廠商**：ID、完整名稱須符合已確認資料；名稱只去首尾空白，不模糊比對、不自動接受別名。
3. **活動**：ID、名稱、日期固定核對；日期限有效 YYYY-MM-DD，不推測其他格式或時區。
   額外必填欄位由 requiredEventFields 傳入，[] 表示無其他必填、null 表示未決。
   非必填但實際帶入的欄位仍核對已確認基準，已列入但值未知時須人工確認；不使用的選填欄位可不列入。
   不自行規定活動前幾天停止寄信。
4. **附件**：requirement 為 required／optional／unknown。
   required 無附件時阻擋；optional 無附件時通過；unknown 維持待確認。
   有附件時核對指定 fileRef；required 須包含全部指定檔案，額外未指定檔案交人工確認。
   基準 version 明確為 null 時不比較版本；有指定版本才要求確認實際版本並檢查一致性。
   不只靠檔名推斷檔案身分，不驗證實際位元組、檔案內容、MIME type 或 PDF 真偽。
5. **連結**：只檢查 HTTP／HTTPS 的格式及輸入證據，不連網，不宣稱完成安全或存取權限驗證。
   HTTP 一律需人工確認，即使輸入證據表示可存取也不自動通過。
   HTTPS 仍須有適用且可信的「有效」與「收件人可存取」證據；未知保持待確認，已知失效或拒絕則阻擋。

附件 optional 且清單為空時，指定檔案／版本不會反過來讓附件變成必填。
同理，明確不要求連結且連結清單為空時，不需要虛構存取證據。

## 人工確認證據

每筆連結確認須具備確認人、有效的含時區時間，並對應：

- 信件 ID、信件版本、基準資料版本。
- 目前唯一 To 地址。
- 完整附件 fileRef／版本快照（保留重複項，僅順序不影響比對）。
- 目前 URL 與資源版本；非版本化資源可明確填 null。

收件人、附件版本、URL、資源版本、信件或基準版本改變時，舊證據不能直接沿用。
新資料若仍有已知錯誤，確認證據也不會蓋過 block。
同時存在適用的允許與拒絕紀錄時，不任選允許結果放行。
本版只驗證確認時間格式，不自行發明證據有效天數；確認紀錄的更新、撤回與到期政策留待後續整合。

## 結果

每個項目包含 category、status、穩定的原因 code、中文 message 與 requiredAction。
status 為 pass／needs_review／block；整體結果依 block > needs_review > pass 彙整，未知資訊不當作 pass。
`counts` 是各狀態 finding 的數量，不是五個類別的固定數量。

`checkPreSend()` 同時固定回報：

```text
validationScope: structured_data_only
finalMessageValidation: not_checked
perMessageApproval: not_checked
```

不提供 canSend、寄送動作或人工核准功能。主旨／正文內容、核准版本生命週期、
每日額度的原子化保留、寄送重入保護及真正發送，仍由後續草稿／審核／寄送流程處理。

## 驗證（Windows PowerShell）

```powershell
npm.cmd test
node node_modules/typescript/bin/tsc --noEmit --incremental false
node node_modules/eslint/bin/eslint.js lib/pre-send
```

測試使用虛構資料與固定確認時間，不讀 .env.local、不呼叫 Google 或 AI。
