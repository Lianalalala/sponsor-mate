// 首頁「連接社團帳號」表單送到這裡。流程寫在 lib/club-connect/flow.ts。

import { createConnectDeps } from "@/lib/club-connect/deps";
import { handleStart } from "@/lib/club-connect/flow";

export async function POST(request: Request) {
  const deps = createConnectDeps();
  if (!deps) {
    return new Response(null, { status: 303, headers: { Location: "/?connect_error=not_configured" } });
  }
  return handleStart(request, deps);
}
