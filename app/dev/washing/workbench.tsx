"use client";

import type { ImportDisposition, WashedRow } from "@/lib/washing/pipeline";

import {
  buttonQuiet,
  MappingStep,
  PickFile,
  useWashingUpload,
  type WashOutput,
} from "../../import/upload-steps";

const DISPOSITIONS: Record<ImportDisposition, { strip: string; badge: string }> = {
  阻擋正式匯入: { strip: "bg-[#B3261E]", badge: "bg-[#B3261E] text-white" },
  待人工覆核: { strip: "bg-[#E0A100]", badge: "bg-[#FFD667] text-[#3B2D00]" },
  "可暫存／禁止聯絡": { strip: "bg-[#3A2A5E]", badge: "bg-[#3A2A5E] text-white" },
  可暫存: { strip: "bg-[#2E8B6F]", badge: "bg-[#CDEEDF] text-[#0E4A38]" },
};

const STEPS = ["放進舊資料", "確認欄位", "檢查結果"];

export default function WashingWorkbench() {
  const { file, analysis, fields, setFields, output, setOutput, busy, error, step, reset, analyze, onPickFile, wash } =
    useWashingUpload("/api/dev/washing");

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
  const writable = output.rows.filter((row) => row.disposition.startsWith("可暫存"));
  const noName = output.rows.filter((row) => row.disposition === "阻擋正式匯入");
  const duplicates = output.rows.filter((row) => row.disposition === "待人工覆核");
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
        {writable.length} 筆可以暫存
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
          <h3 className="text-lg font-semibold">待人工覆核（疑似重複、狀態或窗口要確認）</h3>
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
          <h3 className="text-lg font-semibold">阻擋正式匯入（缺廠商名稱或沒有有效 Email）</h3>
          <ul className="mt-2 divide-y divide-[#D3E2E7] border-l-[6px] border-[#B3261E] bg-white">
            {noName.map((row) => (
              <PendingRow key={row.rowNumber} row={row} title={row.vendorName ?? "（沒有廠商名稱）"} />
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
