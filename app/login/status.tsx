import { headers } from "next/headers";

import { isAuthConfigured } from "@/lib/auth";
import { getCurrentUser } from "@/lib/current-member";
import { ROLE_LABEL } from "@/lib/members";

import { SignInButton, SignOutButton } from "./buttons";

export default async function LoginStatus({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const { error } = await searchParams;

  if (!isAuthConfigured()) {
    return <p className="mt-6">登入功能還沒設定完成，請聯絡專案開發者。</p>;
  }

  const user = await getCurrentUser(await headers());

  if (!user) {
    return (
      <div className="mt-6">
        {error && (
          <p role="alert" className="mb-4 border-l-4 border-[#B3261E] bg-white px-4 py-3">
            登入沒有完成，請再試一次。
          </p>
        )}
        <SignInButton />
      </div>
    );
  }

  if (!user.role) {
    return (
      <div className="mt-6">
        <p>{user.email} 不在成員名單裡，請聯絡你們社團的公關長。</p>
        <SignOutButton />
      </div>
    );
  }

  return (
    <div className="mt-6">
      <p>
        已登入 {user.email}，角色是{ROLE_LABEL[user.role]}。
      </p>
      <SignOutButton />
    </div>
  );
}
