import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { checkImportAccess } from "@/lib/current-member";

import ImportWorkspace from "./import-workspace";

export const metadata: Metadata = {
  title: "匯入舊資料",
  robots: { index: false },
};

// 頁面先在伺服器端檢查權限；API（/api/import/*）也會各自再檢查一次。
async function ImportGate() {
  const access = await checkImportAccess(await headers());

  if (!access.allowed && access.status === 401) redirect("/login");

  if (!access.allowed) {
    return (
      <div role="alert" className="mt-6 border-l-4 border-[#B3261E] bg-white px-4 py-3">
        <p className="font-medium">沒有權限</p>
        <p className="mt-1 text-[#46636D]">匯入舊資料只開放公關長使用。需要的話請聯絡你們社團的公關長。</p>
        <Link href="/" className="mt-3 inline-block text-[#0F5C73] underline">回首頁</Link>
      </div>
    );
  }

  return <ImportWorkspace userEmail={access.user.email} />;
}

export default function ImportPage() {
  return (
    <main className="min-h-screen bg-[#EAF3F5] px-4 py-10 text-[#14323C]">
      <div className="mx-auto max-w-5xl">
        <h1 className="text-3xl font-semibold">匯入舊資料</h1>
        <Suspense fallback={<p className="mt-6 text-[#46636D]">正在確認權限…</p>}>
          <ImportGate />
        </Suspense>
      </div>
    </main>
  );
}
