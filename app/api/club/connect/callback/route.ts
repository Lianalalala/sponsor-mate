// Google 授權完成後導回這裡（要加進 Google Cloud 的 Authorized redirect URIs）。
// 流程寫在 lib/club-connect/flow.ts。

import { createConnectDeps } from "@/lib/club-connect/deps";
import { handleCallback } from "@/lib/club-connect/flow";

export async function GET(request: Request) {
  const deps = createConnectDeps();
  if (!deps) {
    return new Response(null, { status: 303, headers: { Location: "/?connect_error=not_configured" } });
  }
  return handleCallback(request, deps);
}
