// 讀上傳的 Excel／CSV，轉成 pipeline 用的 RawTable。
// 只在伺服器端使用。

import Papa from "papaparse";
import readXlsxFile from "read-excel-file/node";

import type { RawTable } from "./pipeline.ts";

// Vercel Functions 的請求大小上限約 4.5 MB，留一點緩衝
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_DATA_ROWS = 5000;

const HEADER_SEARCH_ROWS = 10;
const MIN_HEADER_CELLS = 2;

export class UnsupportedFileError extends Error {}

export interface NamedTable {
  sheetName: string | null;
  table: RawTable;
}

function cellToText(cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  if (cell instanceof Date) return cell.toISOString().slice(0, 10);
  return String(cell);
}

/**
 * 舊表常在最上面放一列標題（例如「112 學年招商名單」），
 * 所以從上往下找第一列至少有兩格內容的當作欄位名稱。
 */
export function toRawTable(grid: string[][]): RawTable | null {
  const candidates = grid.slice(0, HEADER_SEARCH_ROWS);
  const countCells = (row: string[]) => row.filter((cell) => cell.trim() !== "").length;
  // 有些社團的名單只有一欄，找不到兩格以上的列時，用第一列有內容的
  const multiCell = candidates.findIndex((row) => countCells(row) >= MIN_HEADER_CELLS);
  const headerIndex =
    multiCell !== -1 ? multiCell : candidates.findIndex((row) => countCells(row) > 0);
  if (headerIndex === -1) return null;

  const rows = grid.slice(headerIndex + 1);
  if (rows.length > MAX_DATA_ROWS) {
    throw new UnsupportedFileError(`資料超過 ${MAX_DATA_ROWS} 列，請分批匯入`);
  }
  return {
    headers: grid[headerIndex].map((cell) => cell.trim()),
    rows,
    firstDataRowNumber: headerIndex + 2,
  };
}

/** Excel 在台灣存的 CSV 常是 Big5，UTF-8 解不開時改用 Big5 */
export function decodeCsv(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("big5").decode(bytes);
  }
}

export function readCsv(bytes: Uint8Array): NamedTable[] {
  const text = decodeCsv(bytes).replace(/^﻿/, "");
  const { data } = Papa.parse<string[]>(text, { skipEmptyLines: false });
  const last = data[data.length - 1];
  const grid = last && last.length === 1 && last[0] === "" ? data.slice(0, -1) : data;
  const table = toRawTable(grid);
  return table ? [{ sheetName: null, table }] : [];
}

export async function readXlsx(bytes: Buffer): Promise<NamedTable[]> {
  const sheets = await readXlsxFile(bytes);
  return sheets.flatMap(({ sheet, data }) => {
    const table = toRawTable(data.map((row) => row.map(cellToText)));
    return table ? [{ sheetName: sheet, table }] : [];
  });
}

const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0];
const ZIP_SIGNATURE = [0x50, 0x4b];

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

/** 依檔案內容判斷格式，不只看副檔名 */
export async function readUploadedTable(fileName: string, bytes: Buffer): Promise<NamedTable[]> {
  if (bytes.length > MAX_FILE_BYTES) {
    throw new UnsupportedFileError("檔案超過 4 MB，請分批匯入");
  }
  const extension = fileName.split(".").pop()?.toLowerCase();

  if (startsWith(bytes, OLE_SIGNATURE)) {
    throw new UnsupportedFileError("不支援舊版 .xls，請在 Excel 另存成 .xlsx");
  }
  if (extension === "xlsx" && startsWith(bytes, ZIP_SIGNATURE)) return readXlsx(bytes);
  if (extension === "csv") return readCsv(bytes);
  throw new UnsupportedFileError(`目前不支援這個檔案格式：${fileName}`);
}
