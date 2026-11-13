---
name: wrap-up
description: sponsor-mate 的收工流程。使用者輸入 /wrap-up，或說「今日專案已結束」「今天進度到這裡」「收工」之類的話時使用：整理這次工作，更新 Notion 的 Project Tracker、決策紀錄、開發日誌與 office 首頁「下次開會討論事項」。
---

# 收工流程

收工流程的正式版本寫在 Notion〈開發日誌 Dev Log〉頁的「收工流程」與「紀錄格式」兩個折疊區塊。**每次都要重新讀那一頁**，Notion 和本檔有衝突時以 Notion 為準，並提醒使用者更新本檔。

相關頁面連結見 `AGENTS.md` 的「Notion 連結」。

## 第一步：收集資料（不用問使用者）

1. **這次 session 做了什麼**：回顧本次對話；再用 git 確認實際改動
   - `git status`：目前在哪個 branch、有沒有還沒 commit 的改動；`git diff --stat` 看改了哪些檔案
   - `git log --since="midnight" --oneline`：今天的 commit
   - `git log --oneline main..HEAD`：這個 branch 還沒合併進 `main` 的 commit
   - `git fetch` 後 `git log --oneline HEAD..origin/main`：對方今天有沒有合併新東西進 `main`
   - repo 是 https://github.com/Lianalalala/sponsor-mate ，commit 連結格式為 `https://github.com/Lianalalala/sponsor-mate/commit/<hash>`
2. **讀 Notion**（每次都重讀，兩個人都會更新）：
   - 開發日誌 Dev Log：收工流程、紀錄格式、最上面幾筆紀錄
   - 決策紀錄 Decision Log：目前最大的 D 編號、待定事項
   - 專案進度表 Project Tracker：In progress、截止日已到、本次有關的 Task
   - office 首頁：「下次開會討論事項」

## 第二步：一則訊息問完

把下列問題**整理成一則訊息**一次問，不要分開問。已經能從對話或 git 確定的，直接寫出來請使用者確認就好：

1. **紀錄人**：Liana 或蘇（不確定才問）
2. **Task 狀態**：列出相關 Task，問每個是 To Do／In progress／Done，有沒有新增或改期
3. **決策**：列出這次對話中看起來像決定的事，問哪些要記成正式決策（D-xxx）、狀態是 ✅ 確定還是 🟡 暫定；待定事項有沒有定案；有沒有跟企劃書不同、要記成「範圍變更」的
4. **下次開會**：日期，以及要討論的事
5. **程式碼要收到哪裡**（由使用者決定，不要自己 commit、push 或合併）：
   - 有還沒 commit 的改動 → 要不要 commit
   - 這個 branch 要不要 push 上 GitHub（沒做完也建議 push，東西才不會只在一台電腦上）
   - 這件事做完了嗎 → 做完就開 PR 合併回 `main`；沒做完就留著，下次開工繼續

## 第三步：起草，確認後一次寫入

使用者回答後，先把要寫入的內容全部給使用者看，確認後再一次更新 Notion：

- **開發日誌**：依「紀錄格式」寫一筆，放在格式區塊下方、所有舊紀錄的最上面。同一天同一次 session 只寫一筆，不要拆成很多小段。「相關連結」附上 commit 連結
- **決策紀錄**：新決策在「決策一覽」和「決策總表（詳細）」兩張表都加一列，填寫決策者；待定事項定案就把該列刪掉
- **Project Tracker**：更新 Task 狀態與日期
- **office 首頁「下次開會討論事項」**：移除已處理的，加上下次要做與要討論的事，寫上下次開會日期

## 第四步：push 與 Pull Request（使用者同意後才做）

依第二步第 5 題的回答處理。**絕對不要直接 push 到 `main`**；如果發現自己在 `main` 上有改動，先停下來問使用者，建議開 branch 再 commit。

1. commit 前跑 `npm test`；push 前跑 `npm run build`
2. 第一次 push 這個 branch：`git push -u origin <名稱>`；之後只要 `git push`
3. 要合併回 `main` 時，請使用者到 GitHub 開 PR（repo 頁上方會出現「Compare & pull request」），並提供可以直接貼上的：
   - **標題**：一句話說明這個 branch 做了什麼
   - **說明**：做了什麼、怎麼測的（`npm test`、`npm run build` 的結果）、還沒做的事
4. 合併前，GitHub 顯示衝突（conflict）就停下來，不要在網頁上自己選；改在本機 `git merge main` 處理，並說明兩邊各改了什麼
5. 合併之後回到 `main`：`git switch main`、`git pull`，再用 `git branch -d <名稱>` 刪掉本機已合併的 branch
6. 開發日誌的「相關連結」附上 PR 連結（`https://github.com/Lianalalala/sponsor-mate/pull/<編號>`）或 commit 連結

## 第五步：檢查 AGENTS.md

依 D-010，決策改變時要檢查 `AGENTS.md` 是否需要同步更新（例如技術選型、待定事項定案）。需要的話列出建議修改，等使用者同意再改。

## 規則

- 沒做完的事不要寫成完成；只聽使用者口頭回報、沒有實際查證的，寫清楚「依 XX 回報」
- 機密（API key、token、.env 內容、Client Secret）不能寫進 Notion
- 寫入 Notion 失敗時，改成產出可以直接貼上的文字
