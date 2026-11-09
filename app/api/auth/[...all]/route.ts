import { toNextJsHandler } from "better-auth/next-js";

import { getAuth, isAuthConfigured } from "@/lib/auth";

const notConfigured = () => Response.json({ error: "登入功能還沒設定" }, { status: 503 });

export async function GET(request: Request) {
  if (!isAuthConfigured()) return notConfigured();
  return toNextJsHandler(getAuth()).GET(request);
}

export async function POST(request: Request) {
  if (!isAuthConfigured()) return notConfigured();
  return toNextJsHandler(getAuth()).POST(request);
}
