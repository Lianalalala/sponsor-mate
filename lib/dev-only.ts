// 還沒有登入功能前，會用到 AI key 的工具只能在自己的電腦上用。
// 部署後（NODE_ENV=production）一律關閉；開發時也只接受 localhost，
// 避免同一個 Wi-Fi 的人連進來，或其他網站偷偷呼叫。

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLocalHostname(hostWithPort: string | null): boolean {
  if (!hostWithPort) return false;
  return LOCAL_HOSTS.has(hostWithPort.replace(/:\d+$/, ""));
}

export function isLocalToolEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}

export function isLocalRequest(request: Request): boolean {
  if (!isLocalToolEnabled()) return false;
  if (!isLocalHostname(request.headers.get("host"))) return false;
  const origin = request.headers.get("origin");
  return origin === null || isLocalHostname(new URL(origin).host);
}
