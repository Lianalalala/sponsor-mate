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

## Notion 連結
Notion 工作區是最新狀態的唯一依據。實作功能或做技術選擇前，先讀相關頁面。
- 主頁「最強一人公關部 office」：https://app.notion.com/p/3f02685d18798047b3fcd41edf05d807
- 決策紀錄 Decision Log：https://app.notion.com/p/3f42685d187981d48ab0c18c2caffeea
- 系統架構 System Architecture：https://app.notion.com/p/3f42685d1879816e8378dd53a127cb8b
- 專案進度表 Project Tracker：https://app.notion.com/p/e282685d18798341aa1f0120d87e5a2d
- 開發日誌 Dev Log：https://app.notion.com/p/3fb2685d1879812ba29dc68b60a3711b

## 技術選型
- Next.js（App Router，程式碼放根目錄 app/）、TypeScript、Tailwind CSS
- 部署：Vercel（Hobby 方案），GitHub repo 為 public
- 登入：Better Auth＋Google 登入，成員名單在環境變數（D-017）
- AI：Vercel AI SDK，模型設定集中在 lib/ai/model.ts，只能在伺服器端使用（D-018）
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
- 改完程式跑 `npm test`，確認規則沒被改壞（不呼叫 AI、不花錢）
- push 前跑 `npm run build`，確認 Vercel 部署不會失敗
- 不要自行 commit 或 push，由使用者決定

## 開工與收工流程
- 使用者說「開工」時，依 `.claude/skills/start/SKILL.md` 的步驟處理。
- 使用者說「今日專案已結束」「收工」時，依 `.claude/skills/wrap-up/SKILL.md` 的步驟處理。
