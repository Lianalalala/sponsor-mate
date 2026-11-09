import type { Metadata } from "next";
import { Suspense } from "react";

import LoginStatus from "./status";

export const metadata: Metadata = { title: "登入" };

export default function LoginPage(props: PageProps<"/login">) {
  return (
    <main className="min-h-screen bg-[#EAF3F5] px-4 py-16 text-[#14323C] sm:py-24">
      <div className="mx-auto max-w-md">
        <h1 className="text-3xl font-semibold">登入 Sponsor Mate</h1>
        <p className="mt-2 text-[#46636D]">用社團成員的 Google 帳號登入。</p>
        <Suspense fallback={<p className="mt-6 text-[#46636D]">正在確認登入狀態…</p>}>
          <LoginStatus searchParams={props.searchParams} />
        </Suspense>
      </div>
    </main>
  );
}
