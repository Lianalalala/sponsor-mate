"use client";

// /import 的畫面：放進檔案 → 確認欄位 → 一次處理完（D-025）。
// 規則都在 lib/washing/（純程式、有測試）：write-plan.ts 算出能不能確認、要寫進①②③⑤什麼；
// 這裡只負責顯示與操作。這一頁還不會寫進任何試算表，寫入按鈕先停用。

import { useMemo, useState, type FormEvent, type ReactNode } from "react";

import { CONTACT_METHODS, type ContactMethod } from "@/lib/washing/contact";
import { MERGE_DECISIONS, type DuplicateAnalysis, type MergeDecision } from "@/lib/washing/duplicates";
import { refreshDuplicates, type ImportDisposition, type WashField, type WashedRow } from "@/lib/washing/pipeline";
import {
  applyMergeDecision,
  countByDisposition,
  editDefaults,
  orderForReview,
  recheckRow,
  type RowEdit,
} from "@/lib/washing/review";
import { STAGING_COLUMNS } from "@/lib/washing/staging";
import {
  confirmAllReady,
  EMPTY_CHOICES,
  EVENT_COLUMNS,
  eventLabelsOf,
  NEW_VENDOR,
  RECORD_COLUMNS,
  reviewImport,
  setRowAction,
  VENDOR_COLUMNS,
  type BlockerKind,
  type EventChoice,
  type ExistingEvent,
  type ImportChoices,
  type ImportContext,
  type ImportReview,
  type RowAction,
  type RowReview,
  type VendorUnit,
} from "@/lib/washing/write-plan";

import {
  buttonPrimary,
  buttonQuiet,
  MappingStep,
  PickFile,
  useWashingUpload,
  type WashOutput,
} from "./upload-steps";

const STEPS = ["放進舊資料", "確認欄位", "一次處理完"];

// ②現行活動、①既有廠商、③既有往來紀錄：連接社團試算表（Sheets 讀寫）前先是空的（D-025）
const CURRENT_EVENTS: ExistingEvent[] = [];

type ChoicesChange = (change: (current: ImportChoices) => ImportChoices) => void;
type Area = "ready" | "review" | "blocked";

const AREA_OF: Record<ImportDisposition, Area> = {
  可暫存: "ready",
  "可暫存／禁止聯絡": "ready",
  待人工覆核: "review",
  阻擋正式匯入: "blocked",
};

const AREA_STYLE: Record<Area, { label: string; strip: string; badge: string; hint: string }> = {
  ready: {
    label: "資料完整",
    strip: "bg-[#2E8B6F]",
    badge: "bg-[#CDEEDF] text-[#0E4A38]",
    hint: "選好對應活動就能確認",
  },
  review: {
    label: "待人工覆核",
    strip: "bg-[#E0A100]",
    badge: "bg-[#FFD667] text-[#3B2D00]",
    hint: "看過、補好標出來的地方再確認",
  },
  blocked: {
    label: "阻擋正式匯入",
    strip: "bg-[#B3261E]",
    badge: "bg-[#B3261E] text-white",
    hint: "要補好資料才能確認，或稍後處理",
  },
};

const ACTION_LABEL: Record<RowAction, string> = {
  confirm: "確認寫入",
  later: "稍後處理",
  skip: "不匯入",
};

const selectStyle =
  "rounded-md border border-[#7FA6B3] bg-white px-2 py-1.5 focus-visible:outline-2 focus-visible:outline-[#0F5C73]";

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
          // 每次整理結果不同就重新開始
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
  const [choices, setChoices] = useState<ImportChoices>(EMPTY_CHOICES);
  const [batch] = useState(newBatch);

  const context: ImportContext = useMemo(
    () => ({
      vendors: [],
      events: CURRENT_EVENTS,
      records: [],
      batch: { batchId: batch.batchId, sourceName: fileName, createdAt: batch.createdAt, createdBy: userEmail },
    }),
    [batch, fileName, userEmail],
  );
  const review = useMemo(() => reviewImport(rows, choices, context), [rows, choices, context]);
  const sections = orderForReview(rows);
  const readyCount = [...review.rows.values()].filter(
    (row) => row.action === undefined && row.blockers.length === 0,
  ).length;

  const excludedBlank = output.excluded.filter((row) => row.reason === "blank_row").length;
  const excludedSame = output.excluded.filter((row) => row.reason === "exact_duplicate").length;

  /** 編輯後重新檢查；同組的建議可能跟著變，所以整份重新分析 */
  function saveEdit(original: WashedRow, edit: RowEdit) {
    const rechecked = recheckRow(original, edit);
    setRows(refreshDuplicates(rows.map((row) => (row.rowNumber === original.rowNumber ? rechecked : row))));
  }

  const renderRow = (row: WashedRow) => (
    <RowItem
      key={row.rowNumber}
      row={row}
      review={review}
      result={review.rows.get(row.rowNumber)!}
      headers={headers}
      fields={fields}
      choices={choices}
      onChoices={setChoices}
      onSaveEdit={(edit) => saveEdit(row, edit)}
    />
  );

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

      <Stats rows={rows} review={review} />
      {(excludedBlank > 0 || excludedSame > 0) && (
        <p className="mt-2 text-sm text-[#5F7C86]">
          另外已略過 {excludedBlank} 列空白列、{excludedSame} 列完全相同的列。
        </p>
      )}
      {output.missingRows.length > 0 && (
        <p role="alert" className="mt-4 border-l-4 border-[#E0A100] bg-white px-4 py-3">
          AI 漏掉了第 {output.missingRows.join("、")} 列，窗口和贊助內容沒有拆開。可以回去改欄位再整理一次。
        </p>
      )}

      <EventMapping rows={rows} choices={choices} onChoices={setChoices} />

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={buttonPrimary}
          disabled={readyCount === 0}
          onClick={() => setChoices((current) => confirmAllReady(review, current))}
        >
          確認所有沒有問題的列（{readyCount} 筆）
        </button>
        <p className="text-[15px] text-[#46636D]">疑似重複的群組選完合併決定就算確認，不用一筆一筆按。</p>
      </div>

      <div className="mt-6 space-y-4">
        {sections.map((section) =>
          section.duplicateGroup ? (
            <GroupCard
              key={section.duplicateGroup}
              group={section.duplicateGroup}
              rows={section.rows}
              review={review}
              choices={choices}
              onChoices={setChoices}
              renderRow={renderRow}
            />
          ) : (
            renderRow(section.rows[0])
          ),
        )}
      </div>

      <PlanPreview review={review} />
    </section>
  );
}

function Stats({ rows, review }: { rows: WashedRow[]; review: ImportReview }) {
  const counts = countByDisposition(rows);
  const areaCount: Record<Area, number> = {
    ready: counts["可暫存"] + counts["可暫存／禁止聯絡"],
    review: counts["待人工覆核"],
    blocked: counts["阻擋正式匯入"],
  };
  const results = [...review.rows.values()];
  const writing = results.filter((row) => row.writable).length;
  const later = results.filter((row) => row.action === "later").length;
  const skipped = results.filter((row) => row.action === "skip").length;
  const waiting = results.length - writing - later - skipped;

  return (
    <>
      <h2 className="mt-2 text-2xl font-semibold">這一批共 {rows.length} 筆</h2>
      <dl className="mt-4 grid gap-px bg-[#D3E2E7] sm:grid-cols-3">
        {(Object.keys(AREA_STYLE) as Area[]).map((area) => (
          <div key={area} className="bg-white px-4 py-3">
            <dt>
              <span className={`rounded px-2 py-0.5 text-sm font-medium ${AREA_STYLE[area].badge}`}>
                {AREA_STYLE[area].label}
              </span>
            </dt>
            <dd className="mt-2 text-3xl font-semibold tabular-nums">{areaCount[area]}</dd>
            <dd className="mt-1 text-sm text-[#5F7C86]">
              {AREA_STYLE[area].hint}
              {area === "ready" && counts["可暫存／禁止聯絡"] > 0 && `；其中 ${counts["可暫存／禁止聯絡"]} 筆禁止聯絡`}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-[#46636D]">
        會寫入 {writing} 筆・稍後處理 {later} 筆・不匯入 {skipped} 筆・還沒處理完 {waiting} 筆
      </p>
    </>
  );
}

/** 對應活動下拉的值：現行活動 ID，或 history */
function eventValue(choice: EventChoice | undefined): string {
  if (!choice) return "";
  return choice.kind === "existing" ? choice.eventId : "history";
}

function toEventChoice(value: string, defaultName: string, previous?: EventChoice): EventChoice | undefined {
  if (value === "") return undefined;
  if (value === "history") return { kind: "history", name: previous?.kind === "history" ? previous.name : defaultName };
  return { kind: "existing", eventId: value };
}

function EventSelect({
  value,
  label,
  emptyLabel,
  onChange,
}: {
  value: string;
  label: string;
  emptyLabel: string;
  onChange: (value: string) => void;
}) {
  return (
    <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} className={selectStyle}>
      <option value="">{emptyLabel}</option>
      {CURRENT_EVENTS.map((event) => (
        <option key={event.id} value={event.id}>
          {event.name}（{event.id}）
        </option>
      ))}
      <option value="history">建立為歷史活動</option>
    </select>
  );
}

function EventMapping({ rows, choices, onChoices }: { rows: WashedRow[]; choices: ImportChoices; onChoices: ChoicesChange }) {
  const labels = eventLabelsOf(rows);
  if (labels.length === 0) return null;

  function setLabel(label: string, choice: EventChoice | undefined) {
    onChoices((current) => {
      const eventByLabel = { ...current.eventByLabel };
      if (choice) eventByLabel[label] = choice;
      else delete eventByLabel[label];
      return { ...current, eventByLabel };
    });
  }

  return (
    <section className="mt-6 bg-white px-4 py-4" aria-labelledby="event-mapping">
      <h3 id="event-mapping" className="text-lg font-semibold">
        對應活動
      </h3>
      <p className="mt-1 text-[15px] text-[#46636D]">
        每個舊活動名稱選一次，就會套用到同名的每一筆；個別的列點開後還可以另外改。
        {CURRENT_EVENTS.length === 0 && "②的現行活動要等連接社團試算表後才會出現，目前只能選「建立為歷史活動」。"}
      </p>
      <ul className="mt-3 divide-y divide-[#E3EDF0]">
        {labels.map(({ label, count }) => {
          const choice = choices.eventByLabel[label];
          return (
            <li key={label} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2">
              <span className="min-w-40 font-medium">
                {label} <span className="font-normal text-[#5F7C86]">（{count} 筆）</span>
              </span>
              <span aria-hidden="true" className="text-[#8AA2AA]">
                →
              </span>
              <EventSelect
                label={`舊活動「${label}」對應到`}
                value={eventValue(choice)}
                emptyLabel="還沒選"
                onChange={(value) => setLabel(label, toEventChoice(value, label, choice))}
              />
              {choice?.kind === "history" && (
                <label className="flex items-center gap-2 text-[15px]">
                  歷史活動名稱
                  <input
                    value={choice.name}
                    onChange={(event) => setLabel(label, { kind: "history", name: event.target.value })}
                    className={selectStyle}
                  />
                </label>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function GroupCard({
  group,
  rows,
  review,
  choices,
  onChoices,
  renderRow,
}: {
  group: string;
  rows: WashedRow[];
  review: ImportReview;
  choices: ImportChoices;
  onChoices: ChoicesChange;
  renderRow: (row: WashedRow) => ReactNode;
}) {
  const decision = choices.mergeDecisions[group];
  const keptRow = rows.find((row) => review.rows.get(row.rowNumber)?.kept === true);
  const unit = review.units.get(`group:${group}`);

  return (
    <div className="border-2 border-[#E0A100] bg-[#FFF8E1]">
      <MergeQuestion
        group={group}
        count={rows.length}
        analysis={rows[0].duplicate}
        decision={decision}
        onDecide={(next) =>
          onChoices((current) => ({
            ...current,
            mergeDecisions: applyMergeDecision(rows, current.mergeDecisions, group, next),
          }))
        }
      />
      {keptRow && (
        <fieldset className="px-4 pb-3 text-[#3B2D00]">
          <legend className="font-medium">留下哪一筆？（預設是資料比較完整的那筆，其他筆不匯入）</legend>
          <div className="mt-1 flex flex-wrap gap-x-5 gap-y-1">
            {rows.map((row) => (
              <label key={row.rowNumber} className="flex items-center gap-2 text-[15px]">
                <input
                  type="radio"
                  name={`keep-${group}`}
                  checked={keptRow.rowNumber === row.rowNumber}
                  onChange={() =>
                    onChoices((current) => ({ ...current, keepRow: { ...current.keepRow, [group]: row.rowNumber } }))
                  }
                />
                第 {row.rowNumber} 列{row.legacyId && `（舊序 ${row.legacyId}）`}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {unit && <UnitQuestions unit={unit} choices={choices} onChoices={onChoices} />}
      <div className="space-y-px bg-[#E0A100]">{rows.map(renderRow)}</div>
    </div>
  );
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
        {decision
          ? `已選「${decision}」，這一組就算確認了；再按一次可以取消。`
          : "選了就等於確認整組，不用每一筆再按確認。"}
      </p>
    </fieldset>
  );
}

/** 跟①既有廠商是不是同一家、合併後不一致的欄位要用哪個值 */
function UnitQuestions({ unit, choices, onChoices }: { unit: VendorUnit; choices: ImportChoices; onChoices: ChoicesChange }) {
  if (unit.candidates.length === 0 && unit.conflicts.length === 0) return null;

  function setMatch(value: string) {
    onChoices((current) => ({ ...current, vendorMatch: { ...current.vendorMatch, [unit.key]: value } }));
  }

  function setField(field: string, value: string) {
    onChoices((current) => ({
      ...current,
      fieldChoices: {
        ...current.fieldChoices,
        [unit.key]: { ...current.fieldChoices[unit.key], [field]: value },
      },
    }));
  }

  return (
    <div className="mx-4 mb-3 space-y-3 border-l-4 border-[#E0A100] bg-white px-3 py-2 text-[#14323C]">
      {unit.candidates.length > 0 && (
        <fieldset>
          <legend className="font-medium">①已經有疑似同一家的廠商，是同一家嗎？</legend>
          <div className="mt-1 flex flex-col gap-1">
            {unit.candidates.map((vendor) => (
              <label key={vendor.id} className="flex items-center gap-2 text-[15px]">
                <input
                  type="radio"
                  name={`match-${unit.key}`}
                  checked={choices.vendorMatch[unit.key] === vendor.id}
                  onChange={() => setMatch(vendor.id)}
                />
                同一廠商：掛到「{vendor.name}」（{vendor.id}
                {vendor.email ? `・${vendor.email}` : ""}）
              </label>
            ))}
            <label className="flex items-center gap-2 text-[15px]">
              <input
                type="radio"
                name={`match-${unit.key}`}
                checked={choices.vendorMatch[unit.key] === NEW_VENDOR}
                onChange={() => setMatch(NEW_VENDOR)}
              />
              不同廠商：在①新增一家
            </label>
          </div>
        </fieldset>
      )}
      {unit.conflicts.map((conflict) => (
        <fieldset key={conflict.field}>
          <legend className="font-medium">「{conflict.field}」不一致，①要用哪一個？（其他的值會留在原始資料）</legend>
          <div className="mt-1 flex flex-col gap-1">
            {conflict.options.map((option) => (
              <label key={option.value} className="flex items-center gap-2 text-[15px]">
                <input
                  type="radio"
                  name={`field-${unit.key}-${conflict.field}`}
                  checked={conflict.chosen === option.value}
                  onChange={() => setField(conflict.field, option.value)}
                />
                {option.label}
                <span className="text-sm text-[#5F7C86]">（{option.from.join("、")}）</span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

const VALIDITY_NOTE: Record<WashedRow["contactValidity"], string> = {
  not_provided: "",
  unverified: "",
  replaced: "已換窗口，舊窗口會寫進①的備註",
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

type ComparisonLabel =
  | "廠商名稱"
  | "主要聯絡方式"
  | "主要聯絡資訊"
  | "Email"
  | "聯絡窗口"
  | "其他聯絡管道"
  | "聯絡備註"
  | "聯絡日期"
  | "舊活動"
  | "聯絡狀態"
  | "贊助內容"
  | "原負責人";

interface Comparison {
  label: ComparisonLabel;
  raw: string;
  value: string;
  note?: string;
  /** 同一個原始值拆成好幾個欄位時，原始值只顯示一次（跨幾列） */
  rawRowSpan?: number;
  rawShared?: boolean;
}

/** 會擋住寫入的問題對應到哪個欄位；只有這些欄位會標成「要處理」 */
const BLOCKER_FIELD: Partial<Record<BlockerKind, ComparisonLabel>> = {
  廠商名稱: "廠商名稱",
  主要聯絡方式: "主要聯絡方式",
  主要聯絡資訊: "主要聯絡資訊",
  Email: "Email",
};

function comparisons(
  row: WashedRow,
  headers: string[],
  fields: (WashField | "")[],
  blocked: Set<ComparisonLabel>,
): Comparison[] {
  const raw = (field: WashField) => rawFor(row, headers, fields, field);
  const { interpretation } = row;
  const contactRaw = raw("contact");
  const contact: Comparison[] = [
    {
      label: "主要聯絡方式",
      raw: contactRaw,
      value: row.contactMethod ?? "",
      note: row.contactMethod === "Email" ? "有效 Email，程式直接選" : row.contactMethod ? "AI 判斷" : "",
    },
    ...(row.contactMethod === "Email"
      ? []
      : [{ label: "主要聯絡資訊" as const, raw: contactRaw, value: row.contactInfo }]),
    {
      label: "Email",
      raw: contactRaw,
      value: row.email.value ?? "",
      note: row.email.check === "valid" || row.email.check === "missing" ? "" : row.email.note,
    },
    { label: "聯絡窗口", raw: contactRaw, value: interpretation.contactPerson ?? "", note: VALIDITY_NOTE[row.contactValidity] },
    { label: "其他聯絡管道", raw: contactRaw, value: interpretation.otherChannels ?? "" },
    { label: "聯絡備註", raw: contactRaw, value: row.contactNote },
  ];
  const others: Comparison[] = [
    {
      label: "聯絡日期",
      raw: raw("contactDate"),
      value: row.date.iso ?? "",
      note: row.date.check === "valid" || row.date.check === "missing" ? "" : row.date.note,
    },
    { label: "舊活動", raw: raw("eventLabel"), value: row.eventLabel },
    {
      label: "聯絡狀態",
      raw: raw("status"),
      value: row.status.label,
      note: row.status.decision === "待確認" ? "" : row.status.decision,
    },
    { label: "贊助內容", raw: raw("sponsorship"), value: sponsorshipText(interpretation) },
    { label: "原負責人", raw: raw("owner"), value: row.owner },
  ];

  // 原始值和建議值都空白、也沒有擋住寫入的欄位就不顯示
  const keep = (item: Comparison) => item.value !== "" || item.raw !== "" || blocked.has(item.label);
  const name: Comparison = { label: "廠商名稱", raw: raw("vendorName"), value: row.vendorName ?? "" };
  // 聯絡資料那一格拆出來的欄位：只列有值或要處理的；原文只顯示一次
  const shownContact = contact.filter((item) => item.value !== "" || blocked.has(item.label));
  const contactRows = shownContact.length === 0 && contactRaw ? [contact[0]] : shownContact;
  const spanned = contactRows.map((item, index) =>
    index === 0 ? { ...item, rawRowSpan: contactRows.length } : { ...item, rawShared: true },
  );
  return [name, ...spanned, ...others].filter((item) => item.rawShared || item.rawRowSpan || keep(item));
}

function eventSummary(row: WashedRow, result: RowReview): string {
  const label = row.eventLabel.trim() || "（沒有活動）";
  const event = result.event;
  if (!event) return `${label} → 還沒選`;
  if (event.kind === "history") return `${label} → 歷史活動「${event.name}」`;
  return `${label} → ${CURRENT_EVENTS.find((item) => item.id === event.eventId)?.name ?? event.eventId}`;
}

function RowItem({
  row,
  review,
  result,
  headers,
  fields,
  choices,
  onChoices,
  onSaveEdit,
}: {
  row: WashedRow;
  review: ImportReview;
  result: RowReview;
  headers: string[];
  fields: (WashField | "")[];
  choices: ImportChoices;
  onChoices: ChoicesChange;
  onSaveEdit: (edit: RowEdit) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const style = AREA_STYLE[AREA_OF[row.disposition]];
  const title = row.vendorName ?? "（沒有廠商名稱）";
  const unit = result.unitKey?.startsWith("row:") ? review.units.get(result.unitKey) : undefined;
  const blocked = new Set(result.blockers.flatMap((blocker) => BLOCKER_FIELD[blocker.kind] ?? []));
  const parked = result.action === "skip" || result.action === "later";
  // 不會擋住寫入的提醒（日期缺年份、狀態要看等），點開才看得到
  const otherNotes = [...row.reviewReasons, ...row.dataNotes].filter(
    (note) => !note.startsWith("疑似重複") && !note.startsWith("同組欄位不一致") && note !== "主要聯絡方式待確認",
  );
  const rowEvent = choices.eventByRow[row.rowNumber];

  function act(next: RowAction | undefined) {
    onChoices((current) => setRowAction(review, current, row.rowNumber, next));
  }

  function setRowEvent(choice: EventChoice | undefined) {
    onChoices((current) => {
      const eventByRow = { ...current.eventByRow };
      if (choice) eventByRow[row.rowNumber] = choice;
      else delete eventByRow[row.rowNumber];
      return { ...current, eventByRow };
    });
  }

  return (
    <article className={`flex bg-white ${parked ? "opacity-70" : ""}`} aria-label={`原檔第 ${row.rowNumber} 列 ${title}`}>
      <div aria-hidden="true" className={`w-1.5 shrink-0 ${style.strip}`} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3">
          <h3 className="font-semibold">{title}</h3>
          {row.vendorStopContact && (
            <span className="rounded bg-[#3A2A5E] px-2 py-0.5 text-sm font-semibold text-white">禁止聯絡</span>
          )}
          <span className="text-[15px] text-[#46636D]">
            {row.contactMethod ?? "聯絡方式待確認"}・{eventSummary(row, result)}・{row.status.label}
          </span>
          <span className="ml-auto text-sm text-[#5F7C86]">
            第 {row.rowNumber} 列{row.legacyId && `・舊序 ${row.legacyId}`}
          </span>
        </div>

        {result.blockers.length > 0 && !parked && (
          <ul className="mx-4 mt-1.5 flex flex-wrap gap-1.5" aria-label="還要處理">
            {result.blockers.map((blocker) => (
              <li key={blocker.message} className="rounded bg-[#FFF3C4] px-2 py-0.5 text-sm font-medium text-[#3B2D00]">
                ⚠ {blocker.message}
              </li>
            ))}
          </ul>
        )}

        {unit && !parked && (
          <div className="mt-2">
            <UnitQuestions unit={unit} choices={choices} onChoices={onChoices} />
          </div>
        )}

        {open && (
          <div className="mt-2 border-t border-[#E3EDF0]">
            <ComparisonTable rows={comparisons(row, headers, fields, blocked)} blocked={blocked} />
            <div className="flex flex-wrap items-center gap-2 px-4 pb-3 text-[15px]">
              這一筆的對應活動：
              <EventSelect
                label="這一筆的對應活動"
                value={eventValue(rowEvent)}
                emptyLabel="跟著上方的對應"
                onChange={(value) => setRowEvent(toEventChoice(value, row.eventLabel.trim(), rowEvent))}
              />
              {rowEvent?.kind === "history" && (
                <input
                  aria-label="歷史活動名稱"
                  value={rowEvent.name}
                  onChange={(event) => setRowEvent({ kind: "history", name: event.target.value })}
                  className={selectStyle}
                />
              )}
            </div>
            {otherNotes.length > 0 && (
              <ul className="list-inside list-disc bg-[#F6FAFB] px-4 py-2 text-sm text-[#5F7C86]">
                {otherNotes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {editing && <EditForm row={row} onSave={onSaveEdit} onClose={() => setEditing(false)} />}

        <footer className="mt-2 flex flex-wrap items-center gap-2 border-t border-[#E3EDF0] px-4 py-2">
          {result.action && (
            <span className="rounded border border-[#0F5C73] px-2 py-0.5 text-sm font-medium text-[#0F5C73]">
              {result.kept === false ? "被合併，不匯入" : ACTION_LABEL[result.action]}
              {result.actionFromGroup && result.kept !== false && "（群組決定）"}
              {result.action === "confirm" && !result.writable && "・還差上面標出來的地方"}
            </span>
          )}
          {choices.actions[row.rowNumber] ? (
            <button type="button" className={buttonQuiet} onClick={() => act(undefined)}>
              復原
            </button>
          ) : (
            result.kept !== false && (
              <>
                {!result.actionFromGroup && (
                  <button
                    type="button"
                    className="rounded-md border border-[#0F5C73] px-3 py-1.5 font-medium text-[#0F5C73] hover:bg-[#EAF3F5] disabled:cursor-not-allowed disabled:border-[#B9C9CE] disabled:text-[#8AA2AA]"
                    disabled={result.blockers.length > 0}
                    onClick={() => act("confirm")}
                  >
                    確認
                  </button>
                )}
                <button type="button" className={buttonQuiet} onClick={() => act("later")}>
                  稍後處理
                </button>
                <button type="button" className={buttonQuiet} onClick={() => act("skip")}>
                  不匯入
                </button>
              </>
            )
          )}
          <button type="button" className={buttonQuiet} onClick={() => setEditing(true)} disabled={editing}>
            編輯
          </button>
          <button type="button" className={`${buttonQuiet} ml-auto`} aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "收起" : "看完整欄位"}
          </button>
        </footer>
      </div>
    </article>
  );
}

function ComparisonTable({ rows, blocked }: { rows: Comparison[]; blocked: Set<ComparisonLabel> }) {
  return (
    <div className="overflow-x-auto px-4 py-3">
      <table className="w-full min-w-[36rem] text-left text-[15px]">
        <thead className="text-[#46636D]">
          <tr>
            <th scope="col" className="w-28 py-1 font-medium">
              欄位
            </th>
            <th scope="col" className="py-1 font-medium">
              原始值
            </th>
            <th scope="col" aria-label="變成" className="w-6 py-1" />
            <th scope="col" className="py-1 font-medium">
              建議值
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ label, raw, value, note, rawRowSpan, rawShared }) => {
            const isBlocked = blocked.has(label);
            return (
              <tr key={label} className={`border-t border-[#E3EDF0] ${isBlocked ? "bg-[#FFF3C4]" : ""}`}>
                <th scope="row" className="py-1.5 pr-2 align-top font-normal text-[#46636D]">
                  {label}
                  {isBlocked && (
                    <span className="ml-1 rounded bg-[#E0A100] px-1 text-xs font-semibold text-[#3B2D00]">要處理</span>
                  )}
                </th>
                {!rawShared && (
                  <td
                    rowSpan={rawRowSpan}
                    className="min-w-0 break-words border-r border-[#E3EDF0] bg-white py-1.5 pr-2 align-top text-[#5F7C86]"
                  >
                    {raw || "（空白）"}
                    {rawRowSpan !== undefined && rawRowSpan > 1 && (
                      <span className="mt-0.5 block text-xs text-[#8AA2AA]">這一格拆成右邊 {rawRowSpan} 個欄位</span>
                    )}
                  </td>
                )}
                <td aria-hidden="true" className="py-1.5 pl-2 align-top text-[#8AA2AA]">
                  →
                </td>
                <td className="min-w-0 break-words py-1.5 align-top">
                  <span className="font-medium">{value}</span>
                  {note && <span className="ml-2 text-sm text-[#5F7C86]">{note}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function EditForm({ row, onSave, onClose }: { row: WashedRow; onSave: (edit: RowEdit) => void; onClose: () => void }) {
  const defaults = editDefaults(row);
  const [method, setMethod] = useState<ContactMethod | "">(defaults.contactMethod);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSave({
      vendorName: String(form.get("vendorName") ?? ""),
      contactMethod: method,
      contactInfo: String(form.get("contactInfo") ?? ""),
      email: String(form.get("email") ?? ""),
      contactNote: String(form.get("contactNote") ?? ""),
      contactDate: String(form.get("contactDate") ?? ""),
    });
    onClose();
  }

  return (
    <form onSubmit={submit} className="border-t border-[#D3E2E7] bg-[#F6FAFB] px-4 py-3">
      <p className="text-[15px] text-[#46636D]">改好後按「重新檢查」，上面的提醒會跟著更新。</p>
      <div className="mt-2 grid gap-3 md:grid-cols-3">
        <EditField name="vendorName" label="廠商名稱" defaultValue={defaults.vendorName} />
        <label className="flex flex-col gap-1 text-[15px]">
          主要聯絡方式
          <select
            name="contactMethod"
            value={method}
            onChange={(event) => setMethod(event.target.value as ContactMethod | "")}
            className={selectStyle}
          >
            <option value="">待確認</option>
            {CONTACT_METHODS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        {method !== "Email" && (
          <EditField
            name="contactInfo"
            label="主要聯絡資訊"
            defaultValue={defaults.contactInfo}
            placeholder="例如 LINE ID、表單網址"
          />
        )}
        <EditField name="email" label="Email（寄信只用這欄）" defaultValue={defaults.email} type="email" />
        <EditField name="contactNote" label="聯絡備註" defaultValue={defaults.contactNote} placeholder="例如：要跟上一屆要 LINE" />
        <EditField name="contactDate" label="聯絡日期" defaultValue={defaults.contactDate} placeholder="2025-09-15" />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="submit" className={buttonPrimary}>
          重新檢查
        </button>
        <button type="button" className={buttonQuiet} onClick={onClose}>
          取消
        </button>
      </div>
    </form>
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
      <input name={name} type={type} defaultValue={defaultValue} placeholder={placeholder} className={selectStyle} />
    </label>
  );
}

function SheetTable({ columns, rows }: { columns: readonly string[]; rows: Record<string, string | number>[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="text-left text-sm">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col" className="whitespace-nowrap border-b border-[#B9D3DA] px-2 py-1 font-medium">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-b border-[#E3EDF0]">
              {columns.map((column) => (
                <td key={column} className="max-w-[16rem] truncate px-2 py-1" title={String(row[column] ?? "")}>
                  {String(row[column] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PlanPart({ title, summary, children }: { title: string; summary: string; children: ReactNode }) {
  return (
    <details className="border-t border-[#E3EDF0]">
      <summary className="cursor-pointer px-4 py-2.5 focus-visible:outline-2 focus-visible:outline-[#0F5C73]">
        <span className="font-medium">{title}</span> <span className="text-[#46636D]">{summary}</span>
      </summary>
      <div className="px-4 pb-4">{children}</div>
    </details>
  );
}

function PlanPreview({ review }: { review: ImportReview }) {
  const { plan } = review;
  const stagingRows = plan.staging.append.map((cells) =>
    Object.fromEntries(STAGING_COLUMNS.map((column, index) => [column, cells[index]])),
  );
  const empty = <p className="text-[#46636D]">沒有。</p>;

  return (
    <section className="mt-8 bg-white" aria-labelledby="write-plan">
      <h3 id="write-plan" className="px-4 pt-4 text-lg font-semibold">
        寫入計畫
      </h3>
      <p className="px-4 pb-3 text-[15px] text-[#46636D]">
        按下寫入後會照這份計畫寫進社團的試算表。點開可以看每一列的內容。
      </p>
      <PlanPart title="①廠商" summary={`新增 ${plan.vendors.create.length} 家・更新 ${plan.vendors.update.length} 家`}>
        {plan.vendors.create.length > 0 ? <SheetTable columns={VENDOR_COLUMNS} rows={plan.vendors.create} /> : empty}
        {plan.vendors.update.map((item) => (
          <p key={item.vendorId} className="mt-2 text-[15px]">
            更新 {item.vendorId}「{item.name}」：
            {Object.entries(item.changes)
              .map(([column, value]) => `${column} → ${value}`)
              .join("；")}
          </p>
        ))}
      </PlanPart>
      <PlanPart title="②活動" summary={`新增 ${plan.events.create.length} 個歷史活動`}>
        {plan.events.create.length > 0 ? <SheetTable columns={EVENT_COLUMNS} rows={plan.events.create} /> : empty}
      </PlanPart>
      <PlanPart title="③往來紀錄" summary={`新增 ${plan.records.create.length} 筆`}>
        {plan.records.create.length > 0 ? <SheetTable columns={RECORD_COLUMNS} rows={plan.records.create} /> : empty}
      </PlanPart>
      <PlanPart
        title="⑤舊資料暫存（留底）"
        summary={`新增 ${plan.staging.append.length} 筆・更新 ${plan.staging.update.length} 筆`}
      >
        {stagingRows.length > 0 ? <SheetTable columns={STAGING_COLUMNS} rows={stagingRows} /> : empty}
      </PlanPart>
      <div className="flex flex-wrap items-center gap-4 border-t border-[#E3EDF0] px-4 py-4">
        <button type="button" className={buttonPrimary} disabled aria-describedby="write-disabled">
          照計畫寫入①②③⑤
        </button>
        <p id="write-disabled" className="font-medium text-[#8A6100]">
          寫入功能尚未開放
        </p>
      </div>
    </section>
  );
}
