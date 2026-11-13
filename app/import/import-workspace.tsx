"use client";

// /import 的畫面：放進檔案 → 確認欄位 → 逐筆確認。
// 確認規則都在 lib/washing/review.ts（純程式、有測試），這裡只負責顯示與操作。
// 這一頁不會寫進任何試算表；寫入⑤的按鈕先停用。

import { useState, type FormEvent } from "react";

import { CONTACT_METHODS, type ContactMethod } from "@/lib/washing/contact";
import { MERGE_DECISIONS, type DuplicateAnalysis, type MergeDecision } from "@/lib/washing/duplicates";
import type { ImportDisposition, WashField, WashedRow } from "@/lib/washing/pipeline";
import {
  ACTION_LABEL,
  applyAction,
  applyMergeDecision,
  bulkAcceptTargets,
  canConfirm,
  countByDisposition,
  editDefaults,
  flaggedFields,
  orderForReview,
  recheckRow,
  reviewProgress,
  stagingRowsFor,
  type MergeDecisions,
  type ReviewActions,
  type ReviewField,
  type RowEdit,
} from "@/lib/washing/review";
import { IMPORT_DISPOSITIONS, refreshDuplicates } from "@/lib/washing/pipeline";
import { STAGING_COLUMNS } from "@/lib/washing/staging";

import {
  buttonPrimary,
  buttonQuiet,
  MappingStep,
  PickFile,
  useWashingUpload,
  type WashOutput,
} from "./upload-steps";

const STEPS = ["放進舊資料", "確認欄位", "逐筆確認"];

const DISPOSITION_STYLE: Record<ImportDisposition, { strip: string; badge: string; hint: string }> = {
  可暫存: {
    strip: "bg-[#2E8B6F]",
    badge: "bg-[#CDEEDF] text-[#0E4A38]",
    hint: "資料完整，可以放進⑤暫存",
  },
  "可暫存／禁止聯絡": {
    strip: "bg-[#3A2A5E]",
    badge: "bg-[#3A2A5E] text-white",
    hint: "可以暫存，但廠商要求不要再聯絡",
  },
  待人工覆核: {
    strip: "bg-[#E0A100]",
    badge: "bg-[#FFD667] text-[#3B2D00]",
    hint: "要一筆一筆看過才能接受",
  },
  阻擋正式匯入: {
    strip: "bg-[#B3261E]",
    badge: "bg-[#B3261E] text-white",
    hint: "要補好資料、重新檢查通過才能確認",
  },
};

export default function ImportWorkspace({ userEmail }: { userEmail: string }) {
  const upload = useWashingUpload("/api/import");
  const { analysis, fields, setFields, output, setOutput, busy, error, step, reset, analyze, onPickFile, wash, file } =
    upload;

  return (
    <div className="mt-2">
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
      <p className="mt-2 text-[15px] text-[#46636D]">
        檔案只在處理當下讀進伺服器的記憶體，處理完就丟掉，不會存在伺服器上。這一頁還不會寫進任何試算表。
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
        <ReviewStep
          // 每次清洗結果不同就重新開始確認
          key={`${analysis.fileName}-${output.rows.length}-${JSON.stringify(fields)}`}
          output={output}
          fileName={analysis.fileName}
          headers={analysis.headers}
          fields={fields}
          userEmail={userEmail}
          onBack={() => setOutput(null)}
          onReset={reset}
        />
      )}
    </div>
  );
}

function newBatch(): { batchId: string; createdAt: string } {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return { batchId: `IMP-${stamp}`, createdAt: now.toISOString() };
}

function ReviewStep({
  output,
  fileName,
  headers,
  fields,
  userEmail,
  onBack,
  onReset,
}: {
  output: WashOutput;
  fileName: string;
  headers: string[];
  fields: (WashField | "")[];
  userEmail: string;
  onBack: () => void;
  onReset: () => void;
}) {
  const [rows, setRows] = useState<WashedRow[]>(output.rows);
  const [actions, setActions] = useState<ReviewActions>({});
  const [mergeDecisions, setMergeDecisions] = useState<MergeDecisions>({});
  const [batch] = useState(newBatch);

  const counts = countByDisposition(rows);
  const progress = reviewProgress(rows, actions);
  const bulkTargets = bulkAcceptTargets(rows, actions);
  const sections = orderForReview(rows);
  const staging = stagingRowsFor(rows, actions, {
    batchId: batch.batchId,
    sourceName: fileName,
    createdAt: batch.createdAt,
    createdBy: userEmail,
  }, mergeDecisions);

  const excludedBlank = output.excluded.filter((row) => row.reason === "blank_row").length;
  const excludedSame = output.excluded.filter((row) => row.reason === "exact_duplicate").length;

  function setAction(rowNumber: number, action: ReviewActions[number]) {
    setActions((current) => applyAction(rows, current, rowNumber, action));
  }

  function acceptAllSafe() {
    setActions((current) => {
      let next = current;
      for (const rowNumber of bulkAcceptTargets(rows, current)) {
        next = applyAction(rows, next, rowNumber, "accepted");
      }
      return next;
    });
  }

  /** 編輯後重新檢查；通過才標成「已編輯並確認」，沒通過就維持未處理 */
  function saveEdit(original: WashedRow, edit: RowEdit): WashedRow {
    const rechecked = recheckRow(original, edit);
    // 改了名稱或 Email，同組的建議可能跟著變，所以整份重新分析
    const nextRows = refreshDuplicates(
      rows.map((row) => (row.rowNumber === original.rowNumber ? rechecked : row)),
    );
    setRows(nextRows);
    setActions((current) =>
      applyAction(nextRows, current, original.rowNumber, canConfirm(rechecked) ? "edited" : undefined),
    );
    return rechecked;
  }

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[#46636D]">
          {fileName}・批次 {batch.batchId}
        </p>
        <div>
          <button type="button" className={buttonQuiet} onClick={onBack}>
            回去改欄位
          </button>
          <button type="button" className={buttonQuiet} onClick={onReset}>
            清除這批資料
          </button>
        </div>
      </div>

      <h2 className="mt-2 text-2xl font-semibold">這一批共 {rows.length} 筆</h2>
      <dl className="mt-4 grid grid-cols-2 gap-px bg-[#D3E2E7] md:grid-cols-4">
        {IMPORT_DISPOSITIONS.map((label) => (
          <div key={label} className="bg-white px-4 py-3">
            <dt>
              <span className={`rounded px-2 py-0.5 text-sm font-medium ${DISPOSITION_STYLE[label].badge}`}>
                {label}
              </span>
            </dt>
            <dd className="mt-2 text-3xl font-semibold tabular-nums">{counts[label]}</dd>
            <dd className="mt-1 text-sm text-[#5F7C86]">{DISPOSITION_STYLE[label].hint}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-[#46636D]">
        已確認 {progress.confirmed} 筆・不匯入 {progress.skipped} 筆・還沒處理 {progress.pending} 筆
        {(excludedBlank > 0 || excludedSame > 0) &&
          `（另外已略過 ${excludedBlank} 列空白列、${excludedSame} 列完全相同的列）`}
      </p>

      {output.missingRows.length > 0 && (
        <p role="alert" className="mt-4 border-l-4 border-[#E0A100] bg-white px-4 py-3">
          AI 漏掉了第 {output.missingRows.join("、")} 列，窗口和贊助內容沒有拆開。可以回去改欄位再整理一次。
        </p>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button type="button" className={buttonPrimary} disabled={bulkTargets.length === 0} onClick={acceptAllSafe}>
          接受所有「可暫存」的列（{bulkTargets.length} 筆）
        </button>
        <p className="text-[15px] text-[#46636D]">
          「待人工覆核」要一筆一筆看；「阻擋正式匯入」要補好資料才能確認。
        </p>
      </div>

      <div className="mt-6 space-y-4">
        {sections.map((section) =>
          section.duplicateGroup ? (
            <div key={section.duplicateGroup} className="border-2 border-[#E0A100] bg-[#FFF8E1]">
              <MergeQuestion
                group={section.duplicateGroup}
                count={section.rows.length}
                analysis={section.rows[0].duplicate}
                decision={mergeDecisions[section.duplicateGroup]}
                onDecide={(decision) =>
                  setMergeDecisions((current) =>
                    applyMergeDecision(rows, current, section.duplicateGroup!, decision),
                  )
                }
              />
              <div className="space-y-px bg-[#E0A100]">
                {section.rows.map((row) => (
                  <RowCard
                    key={row.rowNumber}
                    row={row}
                    action={actions[row.rowNumber]}
                    headers={headers}
                    fields={fields}
                    onAction={(action) => setAction(row.rowNumber, action)}
                    onSaveEdit={(edit) => saveEdit(row, edit)}
                  />
                ))}
              </div>
            </div>
          ) : (
            <RowCard
              key={section.rows[0].rowNumber}
              row={section.rows[0]}
              action={actions[section.rows[0].rowNumber]}
              headers={headers}
              fields={fields}
              onAction={(action) => setAction(section.rows[0].rowNumber, action)}
              onSaveEdit={(edit) => saveEdit(section.rows[0], edit)}
            />
          ),
        )}
      </div>

      <StagingPreview staging={staging} />

      <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-[#B9D3DA] pt-6">
        <button type="button" className={buttonPrimary} disabled aria-describedby="write-disabled">
          寫入⑤舊資料暫存
        </button>
        <p id="write-disabled" className="font-medium text-[#8A6100]">
          寫入功能尚未開放
        </p>
      </div>
    </section>
  );
}

const VALIDITY_LABEL: Record<WashedRow["contactValidity"], string> = {
  not_provided: "",
  unverified: "未驗證",
  replaced: "已換窗口，不能直接用",
};

function sponsorshipText({ cashNtd, item, quantity, unit }: WashedRow["interpretation"]): string {
  const parts: string[] = [];
  if (cashNtd !== null) parts.push(`現金 ${cashNtd.toLocaleString("en-US")} 元`);
  if (item !== null || quantity !== null) {
    parts.push([item ?? "品項不明", quantity !== null ? `${quantity}${unit ?? ""}` : "數量待確認"].join(" "));
  }
  return parts.join("＋");
}

function rawFor(row: WashedRow, headers: string[], fields: (WashField | "")[], field: WashField): string {
  return headers
    .map((header, column) => (fields[column] === field ? row.raw[header] ?? "" : ""))
    .filter((value) => value.trim() !== "")
    .join("；");
}

interface Comparison {
  label: ReviewField | "其他聯絡管道" | "聯絡備註" | "舊活動" | "原負責人";
  raw: string;
  value: string;
  note?: string;
  /** 同一個原始值拆成好幾個欄位時，原始值只顯示一次（跨幾列） */
  rawRowSpan?: number;
  /** 原始值已經由上面那一列顯示 */
  rawShared?: boolean;
}

/** 「聯絡資料」那一格會被拆成好幾個欄位；原始值只在第一列顯示一次 */
function contactComparisons(row: WashedRow, contactRaw: string): Comparison[] {
  const { interpretation } = row;
  const emailMatters = row.contactMethod === "Email" || row.email.check !== "missing";
  const items: Comparison[] = [
    {
      label: "主要聯絡方式",
      raw: contactRaw,
      value: row.contactMethod ?? "",
      note: row.contactMethod === null ? "待確認" : row.contactMethod === "Email" ? "有效 Email，程式直接選" : "AI 判斷",
    },
  ];
  // 選 Email 時不顯示主要聯絡資訊（D-024）
  if (row.contactMethod !== "Email") {
    items.push({ label: "主要聯絡資訊", raw: contactRaw, value: row.contactInfo });
  }
  items.push(
    {
      label: "Email",
      raw: contactRaw,
      value: row.email.value ?? "",
      note: row.email.check === "valid" || !emailMatters ? "" : row.email.note,
    },
    {
      label: "聯絡窗口",
      raw: contactRaw,
      value: interpretation.contactPerson ?? "",
      note: VALIDITY_LABEL[row.contactValidity],
    },
    { label: "其他聯絡管道", raw: contactRaw, value: interpretation.otherChannels ?? "" },
  );
  if (row.contactNote) items.push({ label: "聯絡備註", raw: contactRaw, value: row.contactNote });
  return items.map((item, index) =>
    index === 0 ? { ...item, rawRowSpan: items.length } : { ...item, rawShared: true },
  );
}

function comparisons(row: WashedRow, headers: string[], fields: (WashField | "")[]): Comparison[] {
  const raw = (field: WashField) => rawFor(row, headers, fields, field);
  const { interpretation } = row;
  return [
    { label: "廠商名稱", raw: raw("vendorName"), value: row.vendorName ?? "" },
    ...contactComparisons(row, raw("contact")),
    {
      label: "聯絡日期",
      raw: raw("contactDate"),
      value: row.date.iso ?? "",
      note: row.date.check === "valid" ? "" : row.date.note,
    },
    { label: "舊活動", raw: raw("eventLabel"), value: row.eventLabel, note: "對應現行活動之後在⑤決定" },
    {
      label: "聯絡狀態",
      raw: raw("status"),
      value: row.status.label,
      note: row.status.decision === "待確認" ? "" : row.status.decision,
    },
    { label: "贊助內容", raw: raw("sponsorship"), value: sponsorshipText(interpretation) },
    { label: "原負責人", raw: raw("owner"), value: row.owner },
  ];
}

function MergeQuestion({
  group,
  count,
  analysis,
  decision,
  onDecide,
}: {
  group: string;
  count: number;
  analysis: DuplicateAnalysis | null;
  decision: MergeDecision | undefined;
  onDecide: (decision: MergeDecision | undefined) => void;
}) {
  return (
    <fieldset className="px-4 py-3 text-[#3B2D00]">
      <legend className="sr-only">疑似重複 {group} 的合併決定</legend>
      <p className="text-lg font-semibold">
        疑似重複 {group}：這 {count} 筆要合併嗎？
      </p>
      {analysis && (
        <>
          <ul className="mt-1 list-disc pl-5 text-[15px]">
            {analysis.evidence.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          {analysis.suggestion && (
            <p className="mt-1 text-[15px]">
              建議：<span className="font-medium">{analysis.suggestion}</span>（只是建議，要你選了才算）
            </p>
          )}
          {analysis.mismatchedFields.length > 0 && (
            <p className="mt-1 text-[15px]">
              欄位不一致：<span className="font-medium">{analysis.mismatchedFields.join("、")}</span>
              （每筆都保留自己的值，不會替你挑）
            </p>
          )}
        </>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {MERGE_DECISIONS.map((option) => {
          const selected = decision === option;
          return (
            <button
              key={option}
              type="button"
              aria-pressed={selected}
              onClick={() => onDecide(selected ? undefined : option)}
              className={`min-h-11 rounded border-2 px-3 text-[15px] font-medium ${
                selected
                  ? "border-[#0F5C73] bg-[#0F5C73] text-white"
                  : "border-[#B88500] bg-white text-[#3B2D00] hover:bg-[#FFF3C4]"
              }`}
            >
              {option}
            </button>
          );
        })}
      </div>
      <p className="mt-1 text-sm">
        {decision ? `已選「${decision}」，再按一次可以取消。` : "還沒決定（⑤的「合併決定」會是空白）。"}
      </p>
    </fieldset>
  );
}

function RowCard({
  row,
  action,
  headers,
  fields,
  onAction,
  onSaveEdit,
}: {
  row: WashedRow;
  action: ReviewActions[number];
  headers: string[];
  fields: (WashField | "")[];
  onAction: (action: ReviewActions[number]) => void;
  onSaveEdit: (edit: RowEdit) => WashedRow;
}) {
  const [editing, setEditing] = useState(false);
  const [recheckFailed, setRecheckFailed] = useState(false);
  const [editMethod, setEditMethod] = useState<ContactMethod | "">(row.contactMethod ?? "");
  const style = DISPOSITION_STYLE[row.disposition];
  const flagged = flaggedFields(row);
  const confirmable = canConfirm(row);
  const title = row.vendorName ?? "（沒有廠商名稱）";

  function submitEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const result = onSaveEdit({
      vendorName: String(form.get("vendorName") ?? ""),
      contactMethod: editMethod,
      contactInfo: String(form.get("contactInfo") ?? ""),
      email: String(form.get("email") ?? ""),
      contactNote: String(form.get("contactNote") ?? ""),
      contactDate: String(form.get("contactDate") ?? ""),
    });
    const passed = canConfirm(result);
    setRecheckFailed(!passed);
    if (passed) setEditing(false);
  }

  return (
    <article className={`flex bg-white ${action === "skipped" ? "opacity-60" : ""}`} aria-label={`原檔第 ${row.rowNumber} 列 ${title}`}>
      <div aria-hidden="true" className={`w-1.5 shrink-0 ${style.strip}`} />
      <div className="min-w-0 flex-1">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3">
          <span className={`rounded px-2 py-0.5 text-sm font-medium ${style.badge}`}>{row.disposition}</span>
          <h3 className="font-semibold">{title}</h3>
          <span className="text-[15px] text-[#5F7C86]">
            原檔第 {row.rowNumber} 列{row.legacyId && `・舊序 ${row.legacyId}`}
          </span>
          {action && (
            <span className="ml-auto rounded border border-[#0F5C73] px-2 py-0.5 text-sm font-medium text-[#0F5C73]">
              {ACTION_LABEL[action]}
            </span>
          )}
        </header>

        {row.vendorStopContact && (
          <p className="mx-4 mt-2 bg-[#3A2A5E] px-3 py-1.5 font-semibold text-white">
            禁止聯絡：廠商要求不要再聯絡，之後任何邀約都不能寄給這家廠商
          </p>
        )}

        {row.reviewReasons.length > 0 && (
          <ul className="mx-4 mt-2 list-inside list-disc text-[15px] font-medium text-[#14323C]">
            {row.reviewReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}

        <div className="overflow-x-auto px-4 py-3">
          <table className="w-full min-w-[36rem] text-left text-[15px]">
            <thead className="text-[#46636D]">
              <tr>
                <th scope="col" className="w-28 py-1 font-medium">欄位</th>
                <th scope="col" className="py-1 font-medium">原始值</th>
                <th scope="col" aria-label="變成" className="w-6 py-1" />
                <th scope="col" className="py-1 font-medium">建議值</th>
              </tr>
            </thead>
            <tbody>
              {comparisons(row, headers, fields).map(({ label, raw, value, note, rawRowSpan, rawShared }) => {
                const isFlagged = flagged.has(label as ReviewField);
                return (
                  <tr key={label} className={`border-t border-[#E3EDF0] ${isFlagged ? "bg-[#FFF3C4]" : ""}`}>
                    <th scope="row" className="py-1.5 pr-2 align-top font-normal text-[#46636D]">
                      {label}
                      {isFlagged && (
                        <span className="ml-1 rounded bg-[#E0A100] px-1 text-xs font-semibold text-[#3B2D00]">待確認</span>
                      )}
                    </th>
                    {!rawShared && (
                      <td
                        rowSpan={rawRowSpan}
                        className="min-w-0 break-words border-r border-[#E3EDF0] bg-white py-1.5 pr-2 align-top text-[#5F7C86]"
                      >
                        {raw || "（空白）"}
                        {rawRowSpan && rawRowSpan > 1 && (
                          <span className="mt-0.5 block text-xs text-[#8AA2AA]">這一格拆成右邊 {rawRowSpan} 個欄位</span>
                        )}
                      </td>
                    )}
                    <td aria-hidden="true" className="py-1.5 pl-2 align-top text-[#8AA2AA]">→</td>
                    <td className="min-w-0 break-words py-1.5 align-top">
                      <span className="font-medium">{value}</span>
                      {note && <span className="ml-2 text-sm text-[#8A6100]">{note}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {row.dataNotes.length > 0 && (
          <ul className="list-inside list-disc border-t border-[#D3E2E7] bg-[#F6FAFB] px-4 py-2 text-sm text-[#46636D]">
            {row.dataNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}

        {editing && (
          <form onSubmit={submitEdit} className="border-t border-[#D3E2E7] bg-[#F6FAFB] px-4 py-3">
            <p className="text-[15px] text-[#46636D]">補好資料後按「重新檢查」，通過才會確認。</p>
            <div className="mt-2 grid gap-3 md:grid-cols-3">
              <EditField name="vendorName" label="廠商名稱" defaultValue={editDefaults(row).vendorName} />
              <label className="flex flex-col gap-1 text-[15px]">
                主要聯絡方式
                <select
                  name="contactMethod"
                  value={editMethod}
                  onChange={(event) => setEditMethod(event.target.value as ContactMethod | "")}
                  className="rounded-md border border-[#7FA6B3] bg-white px-2 py-1.5 focus-visible:outline-2 focus-visible:outline-[#0F5C73]"
                >
                  <option value="">待確認</option>
                  {CONTACT_METHODS.map((method) => (
                    <option key={method} value={method}>
                      {method}
                    </option>
                  ))}
                </select>
              </label>
              {editMethod !== "Email" && (
                <EditField
                  name="contactInfo"
                  label="主要聯絡資訊"
                  defaultValue={editDefaults(row).contactInfo}
                  placeholder="例如 LINE ID、表單網址"
                />
              )}
              <EditField name="email" label="Email（寄信只用這欄）" defaultValue={editDefaults(row).email} type="email" />
              <EditField
                name="contactNote"
                label="聯絡備註"
                defaultValue={editDefaults(row).contactNote}
                placeholder="例如：要跟上一屆要 LINE"
              />
              <EditField name="contactDate" label="聯絡日期" defaultValue={editDefaults(row).contactDate} placeholder="2025-09-15" />
            </div>
            {recheckFailed && (
              <p role="alert" className="mt-2 font-medium text-[#B3261E]">
                重新檢查還沒通過：{row.reviewReasons.join("；")}
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="submit" className={buttonPrimary}>
                重新檢查
              </button>
              <button
                type="button"
                className={buttonQuiet}
                onClick={() => {
                  setEditing(false);
                  setRecheckFailed(false);
                }}
              >
                取消
              </button>
            </div>
          </form>
        )}

        <footer className="flex flex-wrap items-center gap-2 border-t border-[#D3E2E7] px-4 py-2.5">
          {action ? (
            <button type="button" className={buttonQuiet} onClick={() => onAction(undefined)}>
              復原
            </button>
          ) : (
            <>
              <button
                type="button"
                className="rounded-md border border-[#0F5C73] px-3 py-1.5 font-medium text-[#0F5C73] hover:bg-[#EAF3F5] disabled:cursor-not-allowed disabled:border-[#B9C9CE] disabled:text-[#8AA2AA]"
                disabled={!confirmable}
                onClick={() => onAction("accepted")}
              >
                接受
              </button>
              <button
                type="button"
                className={buttonQuiet}
                onClick={() => {
                  setEditMethod(row.contactMethod ?? "");
                  setEditing(true);
                }}
                disabled={editing}
              >
                編輯後確認
              </button>
              <button type="button" className={buttonQuiet} onClick={() => onAction("skipped")}>
                不匯入
              </button>
              {!confirmable && (
                <span className="text-sm text-[#B3261E]">這筆被阻擋，要先「編輯後確認」補好資料</span>
              )}
            </>
          )}
        </footer>
      </div>
    </article>
  );
}

function EditField({
  name,
  label,
  defaultValue,
  type = "text",
  placeholder,
}: {
  name: string;
  label: string;
  defaultValue: string;
  type?: string;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-[15px]">
      {label}
      <input
        name={name}
        type={type}
        defaultValue={defaultValue}
        placeholder={placeholder}
        className="rounded-md border border-[#7FA6B3] bg-white px-2 py-1.5 focus-visible:outline-2 focus-visible:outline-[#0F5C73]"
      />
    </label>
  );
}

function StagingPreview({ staging }: { staging: ReturnType<typeof stagingRowsFor> }) {
  return (
    <details className="mt-8 bg-white">
      <summary className="cursor-pointer px-4 py-3 font-medium text-[#0F5C73] focus-visible:outline-2 focus-visible:outline-[#0F5C73]">
        預覽要放進⑤舊資料暫存的內容（已確認 {staging.length} 筆，{STAGING_COLUMNS.length} 欄）
      </summary>
      {staging.length === 0 ? (
        <p className="px-4 pb-4 text-[#46636D]">還沒有確認的資料。</p>
      ) : (
        <div className="overflow-x-auto px-4 pb-4">
          <table className="text-left text-sm">
            <thead>
              <tr>
                {STAGING_COLUMNS.map((column) => (
                  <th key={column} scope="col" className="whitespace-nowrap border-b border-[#B9D3DA] px-2 py-1 font-medium">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {staging.map((cells) => (
                <tr key={String(cells[0])} className="border-b border-[#E3EDF0]">
                  {cells.map((cell, index) => (
                    <td key={STAGING_COLUMNS[index]} className="max-w-[16rem] truncate px-2 py-1" title={String(cell)}>
                      {String(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}
