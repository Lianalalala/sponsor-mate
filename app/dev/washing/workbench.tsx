"use client";

import { useState, type ChangeEvent } from "react";

import type {
  ColumnMapping,
  ExcludedRow,
  ImportDisposition,
  WashField,
  WashedRow,
} from "@/lib/washing/pipeline";

// 只匯入型別，AI 與讀檔的程式不會進到瀏覽器

interface MappingSuggestion {
  mapping: ColumnMapping;
  uncertainColumns: number[];
  unmappedColumns: number[];
}

interface Analysis {
  fileName: string;
  sheetNames: (string | null)[];
  sheetIndex: number;
  headers: string[];
  rowCount: number;
  samples: string[][];
  suggestion: MappingSuggestion;
}

interface WashOutput {
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

const DISPOSITIONS: Record<ImportDisposition, { strip: string; badge: string }> = {
  無法寫入: { strip: "bg-[#B3261E]", badge: "bg-[#B3261E] text-white" },
  待確認合併: { strip: "bg-[#E0A100]", badge: "bg-[#FFD667] text-[#3B2D00]" },
  "可寫入／禁止聯絡": { strip: "bg-[#3A2A5E]", badge: "bg-[#3A2A5E] text-white" },
  可寫入: { strip: "bg-[#2E8B6F]", badge: "bg-[#CDEEDF] text-[#0E4A38]" },
};

const STEPS = ["放進舊資料", "確認欄位", "檢查結果"];

const buttonPrimary =
  "rounded-md bg-[#0F5C73] px-5 py-2.5 font-medium text-white hover:bg-[#0B4A5D] disabled:cursor-not-allowed disabled:bg-[#9DB4BC] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0F5C73]";
const buttonQuiet =
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

export default function WashingWorkbench() {
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
      const result = await postForm<Analysis>("/api/dev/washing/analyze", form);
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
    setBusy(`正在清洗 ${analysis.rowCount} 筆資料…`);
    setError(null);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("sheetIndex", String(analysis.sheetIndex));
      form.set("mapping", JSON.stringify(toMapping(fields)));
      setOutput(await postForm<WashOutput>("/api/dev/washing/run", form));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "處理時發生錯誤，請再試一次");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="min-h-screen bg-[#EAF3F5] text-[#14323C]">
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-8 sm:py-12">
        <header className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-3">
          <h1 className="text-3xl font-semibold">舊資料清洗</h1>
          <ol className="flex flex-wrap gap-x-5 gap-y-1 text-[15px]">
            {STEPS.map((label, index) => (
              <li
                key={label}
                aria-current={index === step ? "step" : undefined}
                className={index === step ? "font-semibold text-[#0F5C73]" : "text-[#5F7C86]"}
              >
                {index + 1}. {label}
              </li>
            ))}
          </ol>
        </header>
        <p className="mt-2 text-[15px] text-[#46636D]">
          這裡只預覽整理結果，不會寫進試算表，這一頁也只有你的電腦開得到。
        </p>

        {error && (
          <p role="alert" className="mt-6 border-l-4 border-[#B3261E] bg-white px-4 py-3">
            {error}
          </p>
        )}
        {busy && (
          <p role="status" className="mt-6 font-medium text-[#0F5C73]">
            {busy}
          </p>
        )}

        {step === 0 && !busy && <PickFile onPickFile={onPickFile} />}

        {step === 1 && analysis && (
          <MappingStep
            analysis={analysis}
            fields={fields}
            setFields={setFields}
            busy={busy !== null}
            onChangeSheet={(index) => file && void analyze(file, index)}
            onWash={wash}
            onReset={reset}
          />
        )}

        {step === 2 && output && analysis && (
          <ResultStep
            output={output}
            fileName={analysis.fileName}
            onBack={() => setOutput(null)}
            onReset={reset}
          />
        )}
      </div>
    </div>
  );
}

function PickFile({ onPickFile }: { onPickFile: (event: ChangeEvent<HTMLInputElement>) => void }) {
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

function MappingStep({
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
        AI 已先對好每一欄，請看過再開始清洗。用不到的欄選「不匯入」。
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
          開始清洗
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

function ResultStep({
  output,
  fileName,
  onBack,
  onReset,
}: {
  output: WashOutput;
  fileName: string;
  onBack: () => void;
  onReset: () => void;
}) {
  const writable = output.rows.filter((row) => row.reviewReasons.length === 0);
  const noName = output.rows.filter((row) => row.disposition === "無法寫入");
  const duplicates = output.rows.filter((row) => row.disposition === "待確認合併");
  const pendingCount = noName.length + duplicates.length;
  const stopCount = output.rows.filter((row) => row.vendorStopContact).length;

  const duplicateGroups = [...new Set(duplicates.map((row) => row.duplicateGroup))].map((group) =>
    duplicates.filter((row) => row.duplicateGroup === group),
  );

  const excludedBlank = output.excluded.filter((row) => row.reason === "blank_row").length;
  const excludedSame = output.excluded.filter((row) => row.reason === "exact_duplicate").length;

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[#46636D]">{fileName}</p>
        <div>
          <button type="button" className={buttonQuiet} onClick={onBack}>
            回去改欄位
          </button>
          <button type="button" className={buttonQuiet} onClick={onReset}>
            換一個檔案
          </button>
        </div>
      </div>

      <h2 className="mt-2 text-2xl font-semibold">
        {writable.length} 筆廠商資料可以寫入
        {pendingCount > 0 && `，剩餘 ${pendingCount} 筆待確認`}，共 {output.rows.length} 筆
      </h2>

      {stopCount > 0 && (
        <p className="mt-2 font-medium text-[#3A2A5E]">其中 {stopCount} 家要求不要再聯絡，已標記為不可寄信。</p>
      )}
      {(excludedBlank > 0 || excludedSame > 0) && (
        <p className="mt-2 text-[#46636D]">
          已略過
          {excludedBlank > 0 && ` ${excludedBlank} 列空白列`}
          {excludedBlank > 0 && excludedSame > 0 && "、"}
          {excludedSame > 0 && ` ${excludedSame} 列完全相同的列`}。
        </p>
      )}
      {output.missingRows.length > 0 && (
        <p role="alert" className="mt-4 border-l-4 border-[#E0A100] bg-white px-4 py-3">
          AI 漏掉了第 {output.missingRows.join("、")} 列，窗口和贊助內容沒有拆開，請再清洗一次。
        </p>
      )}

      {duplicateGroups.length > 0 && (
        <div className="mt-8">
          <h3 className="text-lg font-semibold">可能是同一家廠商</h3>
          <div className="mt-2 space-y-3">
            {duplicateGroups.map((group) => (
              <ul key={group[0].rowNumber} className="divide-y divide-[#D3E2E7] border-l-[6px] border-[#E0A100] bg-white">
                {group.map((row) => (
                  <PendingRow key={row.rowNumber} row={row} title={row.vendorName ?? ""} />
                ))}
              </ul>
            ))}
          </div>
        </div>
      )}

      {noName.length > 0 && (
        <div className="mt-8">
          <h3 className="text-lg font-semibold">缺廠商名稱，無法寫入</h3>
          <ul className="mt-2 divide-y divide-[#D3E2E7] border-l-[6px] border-[#B3261E] bg-white">
            {noName.map((row) => (
              <PendingRow key={row.rowNumber} row={row} title="（沒有廠商名稱）" />
            ))}
          </ul>
        </div>
      )}

      {writable.length > 0 && (
        <details className="mt-8">
          <summary className="cursor-pointer text-[#0F5C73] focus-visible:outline-2 focus-visible:outline-[#0F5C73]">
            查看可以寫入的 {writable.length} 筆
          </summary>
          <div className="mt-3 space-y-px bg-[#D3E2E7]">
            {writable.map((row) => (
              <RowBand key={row.rowNumber} row={row} />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function PendingRow({ row, title }: { row: WashedRow; title: string }) {
  const details = [row.email.value, row.date.iso, row.eventLabel].filter(Boolean).join("、");
  return (
    <li className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-2.5">
      <span className="font-medium">{title}</span>
      <span className="min-w-0 break-words text-[15px] text-[#46636D]">{details}</span>
      <span className="ml-auto text-[15px] text-[#5F7C86]">原檔第 {row.rowNumber} 列</span>
    </li>
  );
}

function sponsorshipText({ cashNtd, item, quantity, unit }: WashedRow["interpretation"]): string {
  const parts: string[] = [];
  if (cashNtd !== null) parts.push(`現金 ${cashNtd.toLocaleString("en-US")} 元`);
  if (item !== null || quantity !== null) {
    parts.push([item ?? "品項不明", quantity !== null ? `${quantity}${unit ?? ""}` : "數量待確認"].join(" "));
  }
  return parts.join("＋");
}

const VALIDITY_LABEL: Record<WashedRow["contactValidity"], string> = {
  not_provided: "",
  unverified: "未驗證",
  replaced: "已換窗口，不能直接用",
};

function RowBand({ row }: { row: WashedRow }) {
  const disposition = DISPOSITIONS[row.disposition];
  const { interpretation } = row;

  const cleaned: { label: string; value: string; note?: string }[] = [
    { label: "廠商", value: row.vendorName ?? "" },
    { label: "Email", value: row.email.value ?? "" },
    {
      label: "窗口",
      value: interpretation.contactPerson ?? "",
      note: VALIDITY_LABEL[row.contactValidity],
    },
    { label: "其他管道", value: interpretation.otherChannels ?? "" },
    { label: "聯絡日期", value: row.date.iso ?? "" },
    { label: "舊活動", value: row.eventLabel },
    { label: "聯絡狀態", value: row.status.label, note: row.status.decision === "待確認" ? "" : row.status.decision },
    { label: "贊助", value: sponsorshipText(interpretation) },
  ];

  return (
    <article className="flex bg-white">
      <div aria-hidden="true" className={`w-1.5 shrink-0 ${disposition.strip}`} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3">
          <span className={`rounded px-2 py-0.5 text-sm font-medium ${disposition.badge}`}>{row.disposition}</span>
          <span className="text-[15px] text-[#5F7C86]">原檔第 {row.rowNumber} 列</span>
          {row.duplicateGroup && (
            <span className="rounded border border-[#E0A100] px-2 py-0.5 text-sm">疑似重複 {row.duplicateGroup}</span>
          )}
        </div>

        <div className="grid md:grid-cols-2">
          <div className="px-4 py-3 text-[15px] text-[#5F7C86]">
            <h3 className="font-medium text-[#46636D]">整理前</h3>
            <dl className="mt-1 grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1">
              {Object.entries(row.raw).map(([header, value]) => (
                <div key={header} className="contents">
                  <dt className="min-w-0 break-words">{header}</dt>
                  <dd className="min-w-0 break-words">{value || "（空白）"}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="border-t border-[#D3E2E7] px-4 py-3 md:border-t-0 md:border-l">
            <h3 className="font-medium text-[#0F5C73]">整理後</h3>
            <dl className="mt-1 grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1">
            {cleaned.map(({ label, value, note }) => (
              <div key={label} className="contents">
                <dt className="text-[#46636D]">{label}</dt>
                <dd className="min-w-0 break-words font-medium">
                  {value || <span className="font-normal text-[#8AA2AA]">留空</span>}
                  {note && <span className="ml-2 text-sm font-normal text-[#8A6100]">{note}</span>}
                </dd>
              </div>
            ))}
            </dl>
            {row.vendorStopContact && (
              <p className="mt-1 font-semibold text-[#3A2A5E]">不可寄信給這家廠商</p>
            )}
          </div>
        </div>

        {row.dataNotes.length > 0 && (
          <ul className="list-inside list-disc border-t border-[#D3E2E7] bg-[#F6FAFB] px-4 py-2.5 text-[15px] text-[#46636D]">
            {row.dataNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}
