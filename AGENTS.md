<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

---

# 最強一人公關部 sponsor-mate：專案規則

## 專案簡介
給大學社團公關部用的 AI Agent，協助招商贊助的寄信與廠商資料管理。
MVP 只有兩個模組：寄信模組、資料庫模組。不在 MVP 的功能（深度客製化信件、搜尋新廠商、
完整企劃書生成、結案報告自動產出）不要主動實作。

## 使用者
- 開發者是兩位沒有開發經驗的學生：Liana（Mac）、蘇（Windows）
- 用繁體中文說明，技術名詞保留英文
- 每次修改前先說明要改什麼、為什麼；改完說明改了哪些檔案
- 給終端機指令時，依使用者的作業系統提供（Mac 用 Terminal，Windows 用 PowerShell）

## 技術選型
- Next.js（App Router，程式碼放根目錄 app/）、TypeScript、Tailwind CSS
- 部署：Vercel（Hobby 方案），GitHub repo 為 public
- 其他技術選擇（資料庫、Gmail 權限、模型）以團隊的 Notion 決策紀錄為準；
  不確定時先問使用者，不要自行決定

## 安全規則（必須遵守）
- repo 是公開的：API key、密碼、token 只能放在 .env.local，
  不能寫進程式碼、註解、測試資料或 commit
- 機密只能在伺服器端使用，不能出現在前端程式碼
- 錯誤紀錄不能包含 API key 或完整信件內容
- 不要修改 .gitignore 中排除 .env 的規則

## 核心原則（必須遵守）
- 對外寄信必須經人工核准才能寄出，程式不能有繞過核准直接寄信的路徑
  （目前依企劃書為逐封核准；是否改為依模板審核屬待定事項，定案前一律逐封）
- 可計算的規則（日期差、次數、上限、寄前檢核）用程式處理，不交給 AI 判斷
- 功能的詳細規格以 Notion 的系統架構與決策紀錄為準；還沒設計的功能不要自行實作

## 工作方式
- 一次只做一件小事，做完讓使用者確認再繼續
- 安裝新套件前先說明用途並徵求同意
- 不要自行 commit 或 push，由使用者決定
