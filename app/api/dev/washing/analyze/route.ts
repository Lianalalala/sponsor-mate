// 本機測試頁 /dev/washing 用：部署後關閉、只接受 localhost，另外也要公關長登入。

import { analyzeUpload } from "@/lib/washing/handlers";
import { washingEndpoint } from "@/lib/washing/http";

export const POST = washingEndpoint(analyzeUpload, { localOnly: true });
