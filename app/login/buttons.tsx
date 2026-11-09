"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";

const primary =
  "rounded-md bg-[#0F5C73] px-5 py-2.5 font-medium text-white hover:bg-[#0B4A5D] disabled:bg-[#9DB4BC] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0F5C73]";
const quiet =
  "rounded-md py-2 text-[#0F5C73] underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-[#0F5C73]";

export function SignInButton() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={primary}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void authClient.signIn.social({
          provider: "google",
          callbackURL: "/login",
          errorCallbackURL: "/login?error=1",
        });
      }}
    >
      {busy ? "正在前往 Google…" : "使用 Google 帳號登入"}
    </button>
  );
}

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      className={quiet}
      onClick={() => {
        void authClient.signOut().then(() => router.refresh());
      }}
    >
      登出
    </button>
  );
}
