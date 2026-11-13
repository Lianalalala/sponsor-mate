// 匯入舊資料（/import）第一步：讀檔，請 AI 建議欄位對應。
// 只開放公關長：washingEndpoint 會先驗證 session 與角色，沒通過就不讀檔、不呼叫 AI。

import { analyzeUpload } from "@/lib/washing/handlers";
import { washingEndpoint } from "@/lib/washing/http";

export const POST = washingEndpoint(analyzeUpload);
