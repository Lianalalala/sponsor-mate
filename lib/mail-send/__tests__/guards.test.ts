import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  approveReview, reconcileReview, submitForReview,
  type ApprovedMailReview, type MailReview, type ReviewDraft,
} from "../../mail-review/index.ts";
import { checkPreSend } from "../../pre-send/index.ts";
import type { Confirmed, PreSendInput } from "../../pre-send/types.ts";
import {
  evaluateSendGuards, type SendGuardActor, type SendGuardFinding, type SendGuardInput,
} from "../guards.ts";

type Mutable<T> = T extends readonly (infer U)[] ? Mutable<U>[] :
  T extends object ? { -readonly [P in keyof T]: Mutable<T[P]> } : T;

// 測試的 JSON 型資料深拷貝後可修改，正式審核型別仍維持 readonly。
function mutableClone<T>(value: T): Mutable<T> {
  return structuredClone(value) as unknown as Mutable<T>;
}

// 只使用虛構身分、信件與固定時間；不讀環境變數，不載入真實身分或憑證。
function draft(): ReviewDraft {
  return {
    id: "draft-a", revision: "draft-v1", clubId: "club-a",
    to: ["contact@example.com"], cc: [], bcc: [], contactId: "contact-a",
    subject: "虛構邀約主旨", body: "僅供離線測試的完整內文。",
    vendor: { id: "vendor-a", name: "虛構廠商" },
    event: { id: "event-a", name: "虛構活動", date: "2026-12-10", fields: { venue: "虛構場地" } },
    attachments: [{ fileRef: "file-a", version: "file-v1" }],
    links: [{ url: "https://example.com/plan", resourceVersion: "plan-v1" }],
  };
}

function pending(current: ReviewDraft) {
  const result = submitForReview(current, {
    id: "reviewer-a", clubId: current.clubId, canSubmitForReview: true, canApprove: true,
  }, "2026-11-20T10:00:00+08:00");
  assert.ok(result.ok);
  return result.review;
}

function approved(current: ReviewDraft): ApprovedMailReview {
  const result = approveReview(pending(current), current, {
    id: "reviewer-a", clubId: current.clubId, canSubmitForReview: true, canApprove: true,
  }, "2026-11-20T10:01:00+08:00");
  assert.ok(result.ok);
  return result.review;
}

function fixture(): Mutable<SendGuardInput> {
  const current = draft();
  return mutableClone<SendGuardInput>({
    actor: { id: "sender-a", clubId: current.clubId, canSend: true },
    draft: current, review: approved(current),
    vendor: { clubId: current.clubId, vendorId: current.vendor.id!, revision: "vendor-v1",
      stopContact: { status: "confirmed", value: false } },
  });
}

function expectBlocked(
  input: SendGuardInput, code: SendGuardFinding["code"], reason?: SendGuardFinding["reason"],
) {
  const result = evaluateSendGuards(input);
  assert.ok(result.status === "blocked");
  assert.equal(result.scope, "E01_E02_only");
  assert.ok(result.findings.some((finding) => finding.code === code && (!reason || finding.reason === reason)));
  assert.equal("binding" in result, false);
  return result;
}

function preSendInput(current: ReviewDraft): Mutable<PreSendInput> {
  return mutableClone<PreSendInput>({
    draft: current,
    references: {
      revision: "reference-v1",
      vendor: { status: "confirmed", value: current.vendor },
      contact: { status: "confirmed", value: {
        id: current.contactId, vendorId: current.vendor.id, email: current.to[0], validity: "current",
      } },
      event: { status: "confirmed", value: current.event },
    },
    policy: { requiredEventFields: ["venue"],
      attachments: { requirement: "required", expected: { status: "confirmed", value: current.attachments } },
      linksRequired: false },
    evidence: { source: "trusted_server", links: [] },
  });
}

describe("E01／E02 外寄守門核心（完全離線）", () => {
  it("有效單封核准且目前廠商確定未停止聯絡，只回傳兩項守門通過與版本綁定", () => {
    const input = fixture();
    assert.deepEqual(evaluateSendGuards(input), {
      status: "guards_passed", scope: "E01_E02_only",
      binding: { clubId: "club-a", draftId: "draft-a", draftRevision: "draft-v1",
        vendorId: "vendor-a", vendorRevision: "vendor-v1" },
    });
    assert.equal("canSend" in evaluateSendGuards(input), false);
  });

  it("未登入不能檢核為通過", () => {
    const input = fixture();
    input.actor = null;
    expectBlocked(input, "access", "not_signed_in");
  });

  for (const capability of [false, undefined, "true", 1]) {
    it("寄送能力必須由後端明確提供 true：" + String(capability), () => {
      const input = fixture();
      input.actor!.canSend = capability as boolean;
      expectBlocked(input, "access", "forbidden");
    });
  }

  it("可核准或角色名稱不能取代明確的寄送能力", () => {
    const input = fixture();
    const actor = { id: "sender-a", clubId: "club-a", role: "pr_lead", canApprove: true, canSend: false };
    input.actor = actor;
    expectBlocked(input, "access", "forbidden");
  });

  for (const actor of [
    { id: "", clubId: "club-a", canSend: true },
    { id: "sender-a", clubId: "", canSend: true },
    { id: "sender-a", clubId: null, canSend: true },
    { id: "sender-a", clubId: "club-a" },
  ]) {
    it("不完整身分不能視為有權限：" + JSON.stringify(actor), () => {
      const input = fixture();
      input.actor = actor as SendGuardActor;
      expectBlocked(input, "access", "forbidden");
    });
  }

  for (const target of ["actor", "draft", "vendor"] as const) {
    it("操作人、草稿與廠商須屬於同一社團：" + target, () => {
      const input = fixture();
      if (target === "actor") input.actor!.clubId = "club-b";
      else if (target === "draft") input.draft.clubId = "club-b";
      else input.vendor!.clubId = "club-b";
      const result = expectBlocked(input, "access", "scope_mismatch");
      assert.equal(JSON.stringify(result).includes("club-b"), false);
    });
  }

  it("其他廠商的未停止旗標不能套用到目前草稿", () => {
    const input = fixture();
    input.vendor!.vendorId = "other-vendor";
    expectBlocked(input, "data", "vendor_mismatch");
  });

  it("不完整草稿識別不放行；缺漏整份輸入也不拋出原始錯誤", () => {
    for (const field of ["id", "revision", "clubId"] as const) {
      const input = fixture();
      input.draft[field] = "";
      expectBlocked(input, "data", "draft_identity_invalid");
    }
    const input = fixture();
    input.draft.vendor.id = null;
    expectBlocked(input, "data", "draft_identity_invalid");
    expectBlocked(null as unknown as SendGuardInput, "data", "input_invalid");
  });

  it("E01：缺少核准紀錄，即使外加 approved／canSend／preSend 通過旗標仍阻擋", () => {
    const input = fixture();
    input.review = null;
    const forgedFlags = { ...input, approved: true, canSend: true, status: "approved",
      preSendResult: { status: "pass", perMessageApproval: "approved" } };
    expectBlocked(forgedFlags, "E01", "review_missing");
  });

  it("E01：待審核不是已核准", () => {
    const input = fixture();
    input.review = mutableClone(pending(input.draft));
    expectBlocked(input, "E01", "not_approved");
  });

  for (const review of [
    { status: "approved" },
    { status: "rejected" },
    { status: "draft" },
  ]) {
    it("E01：狀態文字或不合法審核物件不能成為核准：" + JSON.stringify(review), () => {
      const input = fixture();
      input.review = review as Mutable<MailReview>;
      expectBlocked(input, "E01", "review_invalid");
    });
  }

  const invalidApprovals: [string, (review: Mutable<ApprovedMailReview>) => void][] = [
    ["缺少核准人", (review) => { review.approval.reviewerId = ""; }],
    ["核准時間無效", (review) => { review.approval.approvedAt = "invalid"; }],
    ["核准版本不符", (review) => { review.approval.draftRevision = "wrong-version"; }],
  ];
  for (const [label, mutate] of invalidApprovals) {
    it("E01：已核准紀錄仍須通過既有審核結構與版本驗證：" + label, () => {
      const input = fixture();
      mutate(input.review as Mutable<ApprovedMailReview>);
      expectBlocked(input, "E01", "review_invalid");
    });
  }

  for (const target of ["club", "draft"] as const) {
    it("E01：其他社團或其他信件的真實核准紀錄也不能互套：" + target, () => {
      const input = fixture();
      const other = mutableClone(input.draft);
      if (target === "club") other.clubId = "club-b";
      else other.id = "other-draft";
      input.review = mutableClone(approved(other));
      expectBlocked(input, "E01", "review_mismatch");
    });
  }

  const modifications: [string, (draft: Mutable<ReviewDraft>) => void][] = [
    ["主旨", (d) => { d.subject += "修改"; }],
    ["正文", (d) => { d.body += "修改"; }],
    ["To", (d) => { d.to[0] = "changed@example.com"; }],
    ["Cc", (d) => { d.cc.push("copy@example.com"); }],
    ["Bcc", (d) => { d.bcc.push("hidden@example.com"); }],
    ["附件參照", (d) => { d.attachments[0].fileRef = "file-b"; }],
    ["附件版本", (d) => { d.attachments[0].version = "file-v2"; }],
    ["活動資料", (d) => { d.event.fields.venue = "更正後的虛構場地"; }],
    ["連結版本", (d) => { d.links[0].resourceVersion = "plan-v2"; }],
    ["草稿版本", (d) => { d.revision = "draft-v2"; }],
  ];
  for (const [label, modify] of modifications) {
    it("E01：核准後修改" + label + "，即使沒有同步改版本號也不能寄", () => {
      const input = fixture();
      modify(input.draft);
      expectBlocked(input, "E01", "approval_invalidated");
      assert.equal(input.review!.status, "approved", "純檢查不取代 DAL 保存失效紀錄");
    });
  }

  it("E01：失效狀態已保存後，把舊文字與版本改回也不能復活核准", () => {
    const input = fixture();
    const original = mutableClone(input.draft);
    input.draft.body += "修改";
    input.draft.revision = "draft-v2";
    const reconciled = reconcileReview(input.review!, input.draft);
    assert.ok(reconciled.ok);
    assert.equal(reconciled.review.status, "invalidated");
    input.review = mutableClone(reconciled.review);
    input.draft = original;
    expectBlocked(input, "E01", "approval_invalidated");
    assert.ok(input.review?.approval, "舊核准僅留作追溯");
  });

  it("不另外增加自審禁止或核准到期日規則", () => {
    const input = fixture();
    input.actor!.id = "reviewer-a"; // 本次權限能力仍由後端明確提供，未自行制定角色政策。
    assert.equal(evaluateSendGuards(input).status, "guards_passed");
  });

  for (const kind of ["首次邀約", "催信", "其他外寄"]) {
    it("E02：停止聯絡不依外寄類型提供例外：" + kind, () => {
      const input = fixture();
      input.vendor!.stopContact.value = true;
      const outgoing = { ...input, kind };
      expectBlocked(outgoing, "E02", "stop_contact");
    });
  }

  it("E02：不同活動同樣受廠商層級停止聯絡限制", () => {
    const input = fixture();
    input.draft.event.id = "other-event";
    input.review = mutableClone(approved(input.draft));
    input.vendor!.stopContact.value = true;
    expectBlocked(input, "E02", "stop_contact");
  });

  it("E02：已核准後主檔從否變成是，仍立即阻擋；不沿用舊的守門結果", () => {
    const input = fixture();
    const oldResult = evaluateSendGuards(input);
    assert.ok(oldResult.status === "guards_passed");
    input.vendor!.revision = "vendor-v2";
    input.vendor!.stopContact.value = true;
    expectBlocked(input, "E02", "stop_contact");
    assert.equal(input.review!.status, "approved");
    assert.equal(oldResult.binding.vendorRevision, "vendor-v1", "舊結果只是當時版本的判斷");
  });

  for (const stopContact of [
    null, undefined, {},
    { status: "unknown", value: false },
    { status: "unknown", value: true },
    { status: "confirmed", value: null },
    { status: "confirmed", value: undefined },
    { status: "confirmed", value: "否" },
    { status: "confirmed", value: 0 },
  ]) {
    it("停止聯絡資料未確認或不是 boolean 時不得當成否：" + JSON.stringify(stopContact), () => {
      const input = fixture();
      input.vendor!.stopContact = stopContact as Confirmed<boolean>;
      expectBlocked(input, "data", "vendor_unconfirmed");
    });
  }

  it("廠商讀取失敗提供的未知資料、缺少版本或歸屬都不能放行", () => {
    for (const field of ["clubId", "vendorId", "revision"] as const) {
      const input = fixture();
      input.vendor![field] = "";
      expectBlocked(input, "data", "vendor_unconfirmed");
    }
    const input = fixture();
    input.vendor = null; // 模擬正式 loader 無法提供已確認資料；核心本身不查資料庫。
    expectBlocked(input, "data", "vendor_unconfirmed");
  });

  it("同時缺少核准且停止聯絡，可一起回報 E01 與 E02", () => {
    const input = fixture();
    input.review = null;
    input.vendor!.stopContact.value = true;
    const result = expectBlocked(input, "E01");
    assert.ok(result.findings.some((finding) => finding.code === "E02"));
  });

  it("新的窗口資料仍須重跑 pre-send；E01／E02 通過不等於完整寄送許可", () => {
    const input = fixture();
    input.draft.links = [];
    input.review = mutableClone(approved(input.draft));
    const fresh = preSendInput(input.draft);
    assert.equal(checkPreSend(fresh).status, "pass");
    fresh.references!.revision = "reference-v2";
    fresh.references!.contact.value!.email = "new-contact@example.com";
    assert.equal(checkPreSend(fresh).status, "block");
    const result = evaluateSendGuards(input);
    assert.equal(result.status, "guards_passed");
    assert.equal(result.scope, "E01_E02_only");
    assert.equal("canSend" in result, false);
  });

  it("新資料已通過 pre-send，也不能替換舊核准的收件人", () => {
    const input = fixture();
    input.draft.links = [];
    input.review = mutableClone(approved(input.draft));
    input.draft.to[0] = "new-contact@example.com";
    input.draft.revision = "draft-v2";
    const checked = checkPreSend(preSendInput(input.draft));
    assert.equal(checked.status, "pass");
    expectBlocked({ ...input, preSendResult: checked } as SendGuardInput, "E01", "approval_invalidated");
  });

  it("缺少正文等完整結構仍交由既有 review 驗證，不能只看 approved 字樣", () => {
    const input = fixture();
    input.draft.body = undefined as unknown as string;
    expectBlocked(input, "E01", "draft_invalid");
  });

  it("失敗結果與通過綁定不包含完整信件、收件人或核准紀錄", () => {
    for (const rejected of [false, true]) {
      const input = fixture();
      if (rejected) input.draft.body += "修改";
      const result = evaluateSendGuards(input);
      const serialized = JSON.stringify(result);
      for (const privateText of [input.draft.body, input.draft.subject, input.draft.to[0]]) {
        assert.equal(serialized.includes(privateText), false);
      }
      assert.equal("review" in result, false);
      assert.equal("snapshot" in result, false);
    }
  });

  it("非預期核准驗證例外只回固定原因，不回傳原始錯誤", () => {
    const input = fixture();
    input.review = new Proxy(input.review!, {
      get() { throw new Error("private-diagnostic"); },
    });
    const result = expectBlocked(input, "E01", "review_invalid");
    assert.equal(JSON.stringify(result).includes("private-diagnostic"), false);
  });

  it("重複檢查不改輸入；回傳資料也不能被改寫成另一個版本或移除阻擋原因", () => {
    const input = fixture();
    const before = JSON.stringify(input);
    const first = evaluateSendGuards(input);
    assert.deepEqual(evaluateSendGuards(input), first);
    assert.equal(JSON.stringify(input), before);
    assert.ok(Object.isFrozen(first));
    assert.ok(first.status === "guards_passed");
    assert.ok(Object.isFrozen(first.binding));
    assert.throws(() => { (first.binding as Mutable<typeof first.binding>).draftRevision = "forged"; }, TypeError);
    input.review = null;
    const failure = expectBlocked(input, "E01");
    assert.ok(Object.isFrozen(failure.findings));
    assert.ok(Object.isFrozen(failure.findings[0]));
  });
});
