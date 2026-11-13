// 匯入舊資料（/import）第二步：照確認過的欄位對應清洗，只回傳結果，不寫入試算表。
// 只開放公關長：washingEndpoint 會先驗證 session 與角色，沒通過就不讀檔、不呼叫 AI。

import { runWashing } from "@/lib/washing/handlers";
import { washingEndpoint } from "@/lib/washing/http";

export const POST = washingEndpoint(runWashing);
