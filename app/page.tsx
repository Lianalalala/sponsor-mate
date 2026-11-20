import { headers } from "next/headers";
import Link from "next/link";
import { Suspense } from "react";

import { CLUB_NAME_MAX_LENGTH } from "@/lib/club-name";
import { connectNotice } from "@/lib/club-connect/messages";
import { getCurrentUser, importAccessFor } from "@/lib/current-member";

// 首頁的功能入口依角色顯示。只隱藏入口不算權限控管：
// /import 頁面和 /api/import/*、/api/club/connect/* 在伺服器端都會再檢查一次。
async function Entries({ searchParams }: { searchParams: PageProps<"/">["searchParams"] }) {
  const [user, params] = await Promise.all([getCurrentUser(await headers()), searchParams]);
  // 只認得固定的代碼，網址上的其他內容不會顯示在畫面上
  const notice = connectNotice(params);

  return (
    <>
      {notice && (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={`mt-6 border-l-4 bg-white px-4 py-3 ${
            notice.kind === "error" ? "border-[#B3261E]" : "border-[#2E7D32]"
          }`}
        >
          {notice.message}
        </p>
      )}
      {!user ? (
        <p className="mt-6">
          請先 <Link href="/login" className="font-medium text-[#0F5C73] underline">登入</Link>。
        </p>
      ) : !user.role ? (
        <ConnectClub email={user.email} />
      ) : (
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
      )}
    </>
  );
}

/** 已登入、但還不在任何社團的人：可以用社團 Google 帳號連接系統，完成後成為公關長（D-020） */
function ConnectClub({ email }: { email: string }) {
  return (
    <div className="mt-6 space-y-4">
      <p>
        {email} 還不在任何社團的成員名單裡。如果你是組員，請公關長把你加進名單。
      </p>
      <form
        method="post"
        action="/api/club/connect/start"
        className="space-y-3 rounded border border-[#B9D3DA] bg-white px-4 py-4"
      >
        <h2 className="font-medium">我是公關長：連接社團帳號</h2>
        <p className="text-sm text-[#46636D]">
          用社團的 Google 帳號授權「寄信」和「在社團雲端硬碟建立試算表」。
          按下按鈕後 Google 會請你選帳號，請選<strong>社團的</strong>帳號，不是你的個人帳號。
          完成後你會成為這個社團的公關長。
        </p>
        <label className="block">
          <span className="text-sm font-medium">社團名稱</span>
          <input
            name="clubName"
            required
            maxLength={CLUB_NAME_MAX_LENGTH}
            placeholder="例如：台大熱舞社"
            className="mt-1 block w-full rounded border border-[#B9D3DA] px-3 py-2"
          />
        </label>
        <button
          type="submit"
          className="rounded-md bg-[#0F5C73] px-5 py-2.5 font-medium text-white hover:bg-[#0B4A5D] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0F5C73]"
        >
          連接社團帳號
        </button>
      </form>
      <p className="text-sm text-[#46636D]">
        <Link href="/login" className="underline">帳號／登出</Link>
      </p>
    </div>
  );
}

export default function Home(props: PageProps<"/">) {
  return (
    <main className="min-h-screen bg-[#EAF3F5] px-4 py-16 text-[#14323C] sm:py-24">
      <div className="mx-auto max-w-md">
        <h1 className="text-3xl font-semibold">Sponsor Mate</h1>
        <p className="mt-2 text-[#46636D]">社團公關部的招商小幫手。</p>
        <Suspense fallback={<p className="mt-6 text-[#46636D]">正在確認登入狀態…</p>}>
          <Entries searchParams={props.searchParams} />
        </Suspense>
      </div>
    </main>
  );
}
