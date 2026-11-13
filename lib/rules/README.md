# 規則引擎（純函式）

依據：系統架構的寄信模組、D-004、規則引擎 Task（2026/11/15 截止）。

- https://app.notion.com/p/3f42685d1879816e8378dd53a127cb8b
- https://app.notion.com/p/3f42685d187981d48ab0c18c2caffeea
- https://app.notion.com/p/3fb2685d187981f7aa1ffa2f6126e603

從 `lib/rules/index.ts` 匯入。沒有網路、環境變數、系統現在時間、AI 或資料庫依賴。
輸入不會被修改；時間由 `now` 提供，必須是含秒與 Z／±HH:mm 的 ISO 時間。
所有日曆天與每日額度使用 `Asia/Taipei`，不是電腦本機時區，也不是滿 24 小時。

## 輸入與③④的關係

- `Correspondence` 對應③：`id`＝往來ID、`vendorId`＝廠商ID、`eventId`＝活動ID。
- `MailRecord` 對應④：`id`＝信件ID、`correspondenceId`＝往來ID，另含方向、類型、寄送狀態、時間及 Gmail Message ID。
- `clubId` 由呼叫端從可信的社團資料綁定提供；不是新增 Sheets 欄位。規則中的篩選不能代替伺服器登入與權限驗證。
- 傳入同社團完整且最新的歷史，不能只拿第一頁、今天或某個活動的紀錄算社團每日額度。
- `processingDecision` 是內部語意：`continue`／`stop`／`needs_review`。
  停止追蹤（含限該活動）應對應 `stop`，空白或待確認不能當成 `continue`。
  這不新增正式下拉選項；接線時須明確對應③，不能直接套用未知用字。
- `contactStatus` 暫沿用既有清洗模組用字。只有明確「已寄出・尚未回覆」才產生一般催信候選；洽談／合作／未知狀態留給人工處理。
- `vendorStopContact` 是廠商層級；`hasUnhandledReply` 由人工處理回覆後的結果提供。
  不能因收到一封來信就認定回覆已處理；③顯示待處理時也不能用 false 覆蓋。

## 函式

| 函式 | 回傳重點 |
| --- | --- |
| `countSuccessfulSends` | 成功外寄次數、成功催信次數、最後成功時間、未決數、資料問題 |
| `daysSinceLastSuccessfulSend` | 上述統計加台灣日曆天差；無成功、無效時間或未來時間回傳 null |
| `classifyInvitation` | `initial_invitation`／`subsequent_contact`／`needs_review` |
| `evaluateFollowUp` | `recommended`、中文原因與代碼、寄信歷史 |
| `evaluateDailyQuota` | 今日成功數、剩餘額度、未決數、`shouldPause`、核對需求及原因 |
| `toTaipeiDate`／`calendarDaysBetween` | 台灣日期／日曆天差；無效輸入回傳 null |

## 成功證據與上限

只有「寄出＋成功＋非空 Gmail Message ID」計入已確認成功外寄；草稿、失敗、未決及補登來信不計。
同一信件ID或 Message ID 的相同證據不重算；矛盾紀錄回報 `issues`，不能當成可信零寄件放行。
成功證據存在但時間缺漏時，總次數仍計入，日期與當日額度需核對。
人工確認的外寄若缺 API 成功證據，暫回報待核對；人工補登外寄證據的正式支援仍須與團隊對齊。

追蹤設定一定由參數傳入。測試中的 `intervalDays: 3`、`maxFollowUps: 2` 只是暫定值，未建立正式預設。
間隔須為正整數，催信上限須為非負整數；零次表示不催信。
`maxFollowUps` 只計成功的「催信」，首次邀約不算，故首次 1 封＋催信 2 次共 3 封。
「其他外寄」計入成功總數、每日額度及最後成功時間，但不當成催信。

每社團每日 30 封是既有產品規則。29 封成功＋1 封待確認時，`remaining` 仍為 1，
但 `shouldPause` 和 `requiresReconciliation` 皆為 true；不能只讀 remaining 就寄送。
本次保守策略：同社團任何寄送中／待確認紀錄都暫停新增寄送，跨午夜不解除。
資料異常時統計僅反映可確認部分，remaining 不代表安全可用額度。

## 接線限制

催信建議不代表允許直接寄信。接線後仍須逐封人工核准、核准版本檢查、完整寄前檢核與每日額度檢查。
活動期限的具體截止規則未定，本版未自行新增「活動前幾天停止催信」。
本版不預留配額、不實作原子化計數或持久化重入保護；兩個請求仍可能同時看到剩餘 1 封。
真正寄送的後端須在並行請求間保留額度、更新寄送結果並避免重複寄送。
回覆維持 D-004 人工補登，不使用 Gmail 讀信權限。

## 驗證（Windows PowerShell）

```powershell
npm.cmd test
```

`npm.cmd test` 與 `npm test` 使用同一個專案測試腳本，不需安裝新套件。
所有案例使用虛構資料及固定現在時間，不載入 .env.local、不呼叫外部服務、不花 AI 費用。
