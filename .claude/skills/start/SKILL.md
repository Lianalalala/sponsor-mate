---
name: start
description: sponsor-mate 的開工流程。使用者輸入 /start，或說「開工」「今天要開始做了」之類的話時使用：同步 GitHub 最新版本，讀 Notion 整理今天該從哪裡開始。
---

# 開工流程

相關 Notion 頁面連結見 `AGENTS.md` 的「Notion 連結」。

## 第一步：同步程式碼

採用 branch 模式開發：`main` 只放做完、測過的東西，每件事在自己的 branch 上做，做完開 Pull Request（PR）合併回 `main`。

1. `git status`：看目前在哪個 branch（第一行 `On branch ...`），以及有沒有還沒 commit 的改動
   - 有改動的話**先停下來**，列出是哪些檔案、在哪個 branch，問使用者要先 commit、暫存（stash）還是放著，不要自己決定
2. 回到 `main` 拉最新版：`git switch main`，再 `git pull`
   - 遇到衝突（conflict）就停下來，用白話說明是哪個檔案、兩邊各改了什麼，問使用者要保留哪一邊，不要自己合併
3. 有拉到新的 commit 時，用 `git log --oneline ORIG_HEAD..HEAD` 和 `git diff --stat ORIG_HEAD HEAD` 白話說明對方改了什麼（合併了哪些 PR）
   - `package.json` 或 `package-lock.json` 有變動 → 提醒要跑 `npm install`（先徵求同意）
   - `AGENTS.md` 有變動 → 重新讀一次，說明規則改了什麼
4. 看有沒有上次還沒合併的 branch：`git branch --no-merged main`
   - 有的話列出來，到第三步一起問要繼續做，還是已經不需要
   - 也提醒使用者到 GitHub 的 Pull requests 頁看有沒有還沒合併、或等自己看的 PR

## 第二步：讀 Notion（每次都重讀，兩個人都會更新）

- office 首頁：「下次開會討論事項」
- 開發日誌 Dev Log：最上面一筆的「卡關／待解決」和「下一步」，以及紀錄人是誰
- 專案進度表 Project Tracker：In progress、截止日已到或這週到期的 Task，以及負責人
- 決策紀錄 Decision Log：「待定事項」中和今天可能要做的事有關的項目

讀不到 Notion 時直接說明，不要用猜的。

## 第三步：開工簡報

用一則簡短訊息整理，不要長篇：

1. **程式碼**：是否已是最新版；對方上次改了什麼（有的話）
2. **上次停在哪**：最新一筆開發日誌的下一步和卡關
3. **今天建議做的事**：從進行中、快到期的 Task 中挑出 1–3 件，標出負責人和截止日；過期的 Task 特別標出
4. **要注意的待定事項**：做這些事會碰到、但還沒定案的決策（🟡 暫定或待定事項），提醒不要自行決定
5. **還沒合併的 branch**：第一步找到的（有的話），問要繼續做還是已經不需要

最後問使用者今天要從哪一件開始。依 `AGENTS.md`「一次只做一件小事」，選定之後先說明打算怎麼做，確認後再動手。

## 第四步：開 branch（動手寫程式前）

選定要做的事、使用者確認做法後，**在改任何檔案之前**先切到 branch，不要直接在 `main` 上改：

- **新的事**：在最新的 `main` 上開新 branch：`git switch -c <名稱>`
  - 名稱用英文小寫、單字之間用 `-`，說明這次要做什麼，例如 `import-write-staging`、`sheets-write`
  - 一個 branch 只做一件事；先跟使用者確認名稱
- **繼續上次的 branch**：`git switch <名稱>`，再 `git merge main` 把 `main` 的最新版併進來
  - 有衝突就停下來說明，不要自己合併
  - 併完跑 `npm test`，確認對方的改動沒有讓這個 branch 壞掉
