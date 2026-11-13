import { headers } from "next/headers";
import Link from "next/link";
import { Suspense } from "react";

import { getCurrentUser, importAccessFor } from "@/lib/current-member";

// 首頁的功能入口依角色顯示。只隱藏入口不算權限控管：
// /import 頁面和 /api/import/* 在伺服器端都會再檢查一次。
async function Entries() {
  const user = await getCurrentUser(await headers());

  if (!user?.role) {
    return (
      <p className="mt-6">
        請先 <Link href="/login" className="font-medium text-[#0F5C73] underline">登入</Link>。
      </p>
    );
  }

  return (
    <ul className="mt-6 space-y-3">
      {importAccessFor(user).allowed && (
        <li>
          <Link
            href="/import"
            className="block rounded border border-[#B9D3DA] bg-white px-4 py-3 hover:border-[#0F5C73]"
          >
            <span className="font-medium">匯入舊資料</span>
            <span className="mt-1 block text-sm text-[#46636D]">
              上傳舊的 Excel／CSV，整理成資料表的格式並逐筆確認
            </span>
          </Link>
        </li>
      )}
      <li className="text-sm text-[#46636D]">
        已登入 {user.email}（<Link href="/login" className="underline">帳號</Link>）
      </li>
    </ul>
  );
}

export default function Home() {
  return (
    <main className="min-h-screen bg-[#EAF3F5] px-4 py-16 text-[#14323C] sm:py-24">
      <div className="mx-auto max-w-md">
        <h1 className="text-3xl font-semibold">Sponsor Mate</h1>
        <p className="mt-2 text-[#46636D]">社團公關部的招商小幫手。</p>
        <Suspense fallback={<p className="mt-6 text-[#46636D]">正在確認登入狀態…</p>}>
          <Entries />
        </Suspense>
      </div>
    </main>
  );
}
