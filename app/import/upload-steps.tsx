"use client";

// Data washing machine 的前兩步（放進檔案、確認欄位對應），/import 和 /dev/washing 共用。
// 只匯入型別，AI 與讀檔的程式不會進到瀏覽器。

import { useState, type ChangeEvent } from "react";

import type { ColumnMapping, ExcludedRow, WashField, WashedRow } from "@/lib/washing/pipeline";

export interface MappingSuggestion {
  mapping: ColumnMapping;
  uncertainColumns: number[];
  unmappedColumns: number[];
}

export interface Analysis {
  fileName: string;
  sheetNames: (string | null)[];
  sheetIndex: number;
  headers: string[];
  rowCount: number;
  samples: string[][];
  suggestion: MappingSuggestion;
}

export interface WashOutput {
  headers: string[];
  rows: WashedRow[];
  excluded: ExcludedRow[];
  missingRows: number[];
}

const FIELD_OPTIONS: { field: WashField; label: string }[] = [
  { field: "vendorName", label: "廠商名稱" },
  { field: "contact", label: "聯絡方式" },
  { field: "contactDate", label: "聯絡日期" },
  { field: "status", label: "聯絡狀況" },
  { field: "sponsorship", label: "贊助內容" },
  { field: "eventLabel", label: "活動" },
  { field: "owner", label: "負責人" },
  { field: "notes", label: "備註" },
  { field: "legacyId", label: "舊表編號" },
];

const REQUIRED_FIELDS: { field: WashField; label: string }[] = [
  { field: "vendorName", label: "廠商名稱" },
];

export const buttonPrimary =
  "rounded-md bg-[#0F5C73] px-5 py-2.5 font-medium text-white hover:bg-[#0B4A5D] disabled:cursor-not-allowed disabled:bg-[#9DB4BC] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0F5C73]";
export const buttonQuiet =
  "rounded-md px-3 py-2 text-[#0F5C73] underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-[#0F5C73]";

async function postForm<T>(url: string, form: FormData): Promise<T> {
  const response = await fetch(url, { method: "POST", body: form });
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) throw new Error(body?.error ?? "處理時發生錯誤，請再試一次");
  return body as T;
}

function fieldsFromSuggestion(analysis: Analysis): (WashField | "")[] {
  const fields: (WashField | "")[] = analysis.headers.map(() => "");
  for (const [field, columns] of Object.entries(analysis.suggestion.mapping)) {
    for (const column of columns ?? []) fields[column] = field as WashField;
  }
  return fields;
}

function toMapping(fields: (WashField | "")[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  fields.forEach((field, column) => {
    if (field) mapping[field] = [...(mapping[field] ?? []), column];
  });
  return mapping;
}

/** 上傳 → AI 欄位對應 → 清洗。apiBase 例如 "/api/import" */
export function useWashingUpload(apiBase: string) {
  const [file, setFile] = useState<File | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [fields, setFields] = useState<(WashField | "")[]>([]);
  const [output, setOutput] = useState<WashOutput | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const step = output ? 2 : analysis ? 1 : 0;

  function reset() {
    setFile(null);
    setAnalysis(null);
    setFields([]);
    setOutput(null);
    setError(null);
  }

  async function analyze(target: File, sheetIndex: number) {
    setBusy("正在讀檔，請 AI 判斷每一欄的用途…");
    setError(null);
    try {
      const form = new FormData();
      form.set("file", target);
      form.set("sheetIndex", String(sheetIndex));
      const result = await postForm<Analysis>(`${apiBase}/analyze`, form);
      setAnalysis(result);
      setFields(fieldsFromSuggestion(result));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "處理時發生錯誤，請再試一次");
    } finally {
      setBusy(null);
    }
  }

  function onPickFile(event: ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files?.[0];
    event.target.value = "";
    if (!picked) return;
    setFile(picked);
    void analyze(picked, 0);
  }

  async function wash() {
    if (!file || !analysis) return;
    setBusy(`正在整理 ${analysis.rowCount} 筆資料…`);
    setError(null);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("sheetIndex", String(analysis.sheetIndex));
      form.set("mapping", JSON.stringify(toMapping(fields)));
      setOutput(await postForm<WashOutput>(`${apiBase}/run`, form));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "處理時發生錯誤，請再試一次");
    } finally {
      setBusy(null);
    }
  }

  return { file, analysis, fields, setFields, output, setOutput, busy, error, step, reset, analyze, onPickFile, wash };
}

export function PickFile({ onPickFile }: { onPickFile: (event: ChangeEvent<HTMLInputElement>) => void }) {
  return (
    <div className="relative mt-8 border-2 border-dashed border-[#7FA6B3] bg-white hover:border-[#0F5C73] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[#0F5C73]">
      <input
        type="file"
        accept=".xlsx,.csv"
        aria-label="選擇舊資料檔案"
        onChange={onPickFile}
        className="absolute inset-0 cursor-pointer opacity-0"
      />
      <div className="px-6 py-20 text-center">
        <p className="text-xl font-medium">把舊的招商名單拖到這裡，或點一下選擇檔案</p>
        <p className="mt-2 text-[#46636D]">支援 .xlsx 和 .csv，檔案上限 4 MB</p>
      </div>
    </div>
  );
}

export function MappingStep({
  analysis,
  fields,
  setFields,
  busy,
  onChangeSheet,
  onWash,
  onReset,
}: {
  analysis: Analysis;
  fields: (WashField | "")[];
  setFields: (fields: (WashField | "")[]) => void;
  busy: boolean;
  onChangeSheet: (index: number) => void;
  onWash: () => void;
  onReset: () => void;
}) {
  const missing = REQUIRED_FIELDS.filter(({ field }) => !fields.includes(field));
  const { uncertainColumns } = analysis.suggestion;

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">
          {analysis.fileName}，共 {analysis.rowCount} 列
        </h2>
        {analysis.sheetNames.length > 1 && (
          <label className="flex items-center gap-2">
            分頁
            <select
              value={analysis.sheetIndex}
              disabled={busy}
              onChange={(event) => onChangeSheet(Number(event.target.value))}
              className="rounded-md border border-[#7FA6B3] bg-white px-2 py-1.5"
            >
              {analysis.sheetNames.map((name, index) => (
                <option key={index} value={index}>
                  {name ?? `分頁 ${index + 1}`}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <p className="mt-1 text-[#46636D]">
        AI 已先對好每一欄，請確認欄位對應是否正確。用不到的欄位選「不匯入」。
      </p>

      <div className="mt-5 divide-y divide-[#D3E2E7] bg-white">
        {analysis.headers.map((header, column) => {
          const isUncertain = uncertainColumns.includes(column);
          return (
            <div
              key={column}
              className="grid gap-x-6 gap-y-2 px-4 py-3 md:grid-cols-[12rem_1fr_11rem] md:items-center"
            >
              <p className="font-medium">
                {header || `第 ${column + 1} 欄（沒有欄名）`}
                {isUncertain && (
                  <span className="ml-2 rounded bg-[#FFD667] px-1.5 py-0.5 text-sm font-normal text-[#3B2D00]">
                    待確認
                  </span>
                )}
              </p>
              <p className="min-w-0 truncate text-[15px] text-[#5F7C86]">
                {analysis.samples[column].join("、") || "（這欄是空的）"}
              </p>
              <select
                aria-label={`${header} 對應到`}
                value={fields[column]}
                onChange={(event) => {
                  const next = [...fields];
                  next[column] = event.target.value as WashField | "";
                  setFields(next);
                }}
                className="rounded-md border border-[#7FA6B3] bg-white px-2 py-1.5 focus-visible:outline-2 focus-visible:outline-[#0F5C73]"
              >
                <option value="">不匯入</option>
                {FIELD_OPTIONS.map(({ field, label }) => (
                  <option key={field} value={field}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button type="button" className={buttonPrimary} disabled={busy || missing.length > 0} onClick={onWash}>
          開始整理
        </button>
        <button type="button" className={buttonQuiet} onClick={onReset}>
          換一個檔案
        </button>
        {missing.length > 0 && (
          <p className="text-[#B3261E]">
            還需要對應：{missing.map(({ label }) => label).join("、")}
          </p>
        )}
      </div>
    </section>
  );
}

