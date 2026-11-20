import { STAGING_COLUMNS } from "../washing/staging.ts";
import { readStagingRows, type StagingReadClient, type StagingSheetRow } from "./staging-read.ts";

/** 依 D-025 讀回明確標為「待處理」的原始列；呼叫端仍須先完成授權。 */
export async function readPendingStagingRows(client: StagingReadClient): Promise<StagingSheetRow[]> {
  const rows = await readStagingRows(client);
  const statusIndex = STAGING_COLUMNS.indexOf("確認狀態");
  return rows.filter(({ values }) => values[statusIndex] === "待處理");
}
