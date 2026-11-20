import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { generateDraft } from "../../drafts/index.ts";
import {
  approveReview,
  reconcileReview,
  submitForReview,
  type ApprovedMailReview,
  type MailReview,
  type PendingMailReview,
  type ReviewActor,
  type ReviewDraft,
  type ReviewErrorCode,
  type ReviewResult,
} from "../index.ts";

type Mutable<T> = T extends readonly (infer U)[] ? Mutable<U>[] :
  T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;

// 全部為虛構身分、信件與固定時間；能力值僅模擬後端已驗證的結果。
const submitter: ReviewActor = Object.freeze({ id: "member-test", clubId: "club-test", canSubmitForReview: true, canApprove: false });
const reviewer: ReviewActor = Object.freeze({ id: "reviewer-test", clubId: "club-test", canSubmitForReview: true, canApprove: true });
const SUBMITTED_AT = "2026-11-20T14:00:00+08:00";
const APPROVED_AT = "2026-11-20T14:01:00+08:00";

function fixture(): Mutable<ReviewDraft> {
  return {
    id: "draft-test", clubId: "club-test", revision: "r1",
    to: ["contact@example.invalid"], cc: [], bcc: [],
    subject: "虛構活動合作邀約", body: "虛構窗口您好：\n希望洽談活動用品贊助。",
    contactId: "contact-test", vendor: { id: "vendor-test", name: "虛構文具公司" },
    event: { id: "event-test", name: "虛構活動", date: "2026-12-20", fields: { venue: "虛構會館", needs: "活動用品" } },
    attachments: [{ fileRef: "proposal-test", version: "v1" }, { fileRef: "appendix-test", version: null }],
    links: [{ url: "https://files.example.invalid/proposal", resourceVersion: "link-v1" }],
  };
}

function expectReview<T extends MailReview>(result: ReviewResult<T>): T {
  assert.ok(result.ok, result.ok ? undefined : result.message);
  return result.review;
}

function expectFailure(result: ReviewResult, code: ReviewErrorCode) {
  assert.ok(!result.ok);
  assert.equal(result.code, code);
  assert.ok(result.message);
  assert.equal("review" in result, false, "失敗時不能取得部分核准紀錄");
}

function pending(draft: ReviewDraft = fixture()): PendingMailReview {
  return expectReview(submitForReview(draft, submitter, SUBMITTED_AT));
}

function approved(draft: ReviewDraft = fixture()): ApprovedMailReview {
  return expectReview(approveReview(pending(draft), draft, reviewer, APPROVED_AT));
}

describe("逐封審核核心（完全離線）", () => {
  it("可把生成核心的文字組裝成完整草稿後送審，記錄送審人、時間與完整版本", () => {
    const generated = generateDraft({ kind: "initial_invitation", subject: "{{活動}}合作邀約", body: "{{窗口}}您好：\n{{需求}}" }, {
      活動: "虛構活動", 窗口: "虛構窗口", 需求: "希望洽談活動用品贊助。",
    });
    assert.ok(generated.ok);
    const draft = { ...fixture(), subject: generated.draft.subject, body: generated.draft.body };
    const review = pending(draft);
    assert.equal(review.status, "pending_review");
    assert.equal(review.approval, null);
    assert.deepEqual(review.submission, { submittedBy: submitter.id, submittedAt: SUBMITTED_AT });
    assert.deepEqual(review.snapshot, draft);
    assert.notEqual(review.snapshot, draft);
    assert.equal(generated.draft.perMessageApproval, "not_approved");
  });

  it("指定審核者逐封核准，記錄核准人、時間與版本，原送審紀錄維持不變", () => {
    const draft = fixture();
    const submission = pending(draft);
    const review = expectReview(approveReview(submission, draft, reviewer, APPROVED_AT));
    assert.equal(review.status, "approved");
    assert.deepEqual(review.approval, { reviewerId: reviewer.id, approvedAt: APPROVED_AT, draftRevision: "r1" });
    assert.deepEqual(review.snapshot, draft);
    assert.equal(submission.status, "pending_review");
    assert.equal(submission.approval, null);
    assert.equal("canSend" in review, false);
  });

  it("可以送審不代表可以核准，權限值必須明確為 true", () => {
    const draft = fixture();
    expectFailure(approveReview(pending(draft), draft, submitter, APPROVED_AT), "forbidden");
    expectFailure(submitForReview(draft, { ...submitter, canSubmitForReview: false }, SUBMITTED_AT), "forbidden");
    const falsePermission = { ...reviewer, canApprove: "true" } as unknown as ReviewActor;
    expectFailure(approveReview(pending(draft), draft, falsePermission, APPROVED_AT), "forbidden");
  });

  for (const actor of [{ ...reviewer, clubId: "other-club" }, { ...reviewer, id: " " }, null]) {
    it(`缺少有效身分或跨社團時禁止送審與核准：${actor?.id ?? "null"}`, () => {
      const draft = fixture();
      expectFailure(submitForReview(draft, actor as ReviewActor, SUBMITTED_AT), "forbidden");
      expectFailure(approveReview(pending(draft), draft, actor as ReviewActor, APPROVED_AT), "forbidden");
    });
  }

  it("忽略輸入自帶的核准／寄送旗標及檢核狀態，不會因此跳過待審核狀態", () => {
    const draft = { ...fixture(), approved: true, canSend: true, status: "approved", preSendStatus: "pass" };
    const review = pending(draft);
    assert.equal(review.status, "pending_review");
    assert.equal(review.approval, null);
    assert.equal("approved" in review.snapshot, false);
    assert.equal("canSend" in review.snapshot, false);
    assert.equal("preSendStatus" in review.snapshot, false);
  });

  const changes: readonly [string, (draft: Mutable<ReviewDraft>) => void][] = [
    ["版本", (d) => { d.revision = "r2"; }],
    ["To", (d) => { d.to[0] = "other@example.invalid"; }],
    ["Cc", (d) => { d.cc.push("copy@example.invalid"); }],
    ["Bcc", (d) => { d.bcc.push("copy@example.invalid"); }],
    ["收件人空白", (d) => { d.to[0] = ` ${d.to[0]} `; }],
    ["主旨", (d) => { d.subject += "（修改）"; }],
    ["主旨空白", (d) => { d.subject += " "; }],
    ["內文", (d) => { d.body += "\n新增內容"; }],
    ["窗口", (d) => { d.contactId = "other-contact"; }],
    ["廠商 ID", (d) => { d.vendor.id = "other-vendor"; }],
    ["廠商名稱", (d) => { d.vendor.name = "另一家虛構公司"; }],
    ["活動 ID", (d) => { d.event.id = "other-event"; }],
    ["活動名稱", (d) => { d.event.name = "另一場虛構活動"; }],
    ["活動日期", (d) => { d.event.date = "2026-12-21"; }],
    ["活動額外欄位", (d) => { d.event.fields.venue = "另一個虛構會館"; }],
    ["新增活動欄位", (d) => { d.event.fields.newField = null; }],
    ["刪除活動欄位", (d) => { delete d.event.fields.needs; }],
    ["附件參照", (d) => { d.attachments[0].fileRef = "other-file"; }],
    ["附件版本", (d) => { d.attachments[0].version = "v2"; }],
    ["附件順序", (d) => { d.attachments.reverse(); }],
    ["新增附件", (d) => { d.attachments.push({ fileRef: "new-file", version: "v1" }); }],
    ["移除附件", (d) => { d.attachments.pop(); }],
    ["連結 URL", (d) => { d.links[0].url = "https://files.example.invalid/changed"; }],
    ["連結資源版本", (d) => { d.links[0].resourceVersion = "link-v2"; }],
  ];

  for (const [label, change] of changes) {
    it(`修改${label}後，待審核與已核准紀錄都失效；漏改版本號也無法核准`, () => {
      const original = fixture();
      const submission = pending(original);
      const approval = approved(original);
      const changed = fixture();
      change(changed);
      expectFailure(approveReview(submission, changed, reviewer, APPROVED_AT), "draft_changed");
      for (const oldReview of [submission, approval]) {
        const result = expectReview(reconcileReview(oldReview, changed));
        assert.equal(result.status, "invalidated");
        assert.deepEqual(result.snapshot, original, "保留原送審快照，不用新資料覆蓋");
        assert.deepEqual(result.approval, oldReview.approval, "舊核准僅留作追溯");
        if (result.status === "invalidated") assert.equal(result.invalidationReason, "draft_changed");
      }
      assert.equal(approval.status, "approved", "不改動輸入的歷史紀錄");
    });
  }

  it("不同草稿與不同社團的紀錄不可互套", () => {
    for (const change of [{ id: "other-draft" }, { clubId: "other-club" }]) {
      const current = { ...fixture(), ...change };
      expectFailure(reconcileReview(approved(), current), "different_draft");
      expectFailure(approveReview(pending(), current, reviewer, APPROVED_AT), "different_draft");
    }
  });

  it("失效後把文字改回仍然失效，重新送審與核准後才建立新紀錄", () => {
    const oldApproval = approved();
    const changed = { ...fixture(), revision: "r2", body: "修改後的虛構內容" };
    const invalidated = expectReview(reconcileReview(oldApproval, changed));
    assert.equal(expectReview(reconcileReview(invalidated, fixture())).status, "invalidated");
    expectFailure(approveReview(invalidated, changed, reviewer, APPROVED_AT), "invalid_state");
    const newApproval = approved(changed);
    assert.equal(newApproval.approval.draftRevision, "r2");
    assert.equal(newApproval.snapshot.body, changed.body);
    assert.equal(oldApproval.approval.draftRevision, "r1");
  });

  it("已核准紀錄不可再次核准，沒有送審紀錄也不能直接核准", () => {
    expectFailure(approveReview(approved(), fixture(), reviewer, APPROVED_AT), "invalid_state");
    expectFailure(approveReview(null as unknown as MailReview, fixture(), reviewer, APPROVED_AT), "invalid_review");
  });

  it("只有活動欄位的 key 順序不同時不失效，文字與清單仍精確比較", () => {
    const current = fixture();
    current.event.fields = { needs: "活動用品", venue: "虛構會館" };
    assert.equal(expectReview(reconcileReview(approved(), current)).status, "approved");
    assert.equal(expectReview(approveReview(pending(), current, reviewer, APPROVED_AT)).status, "approved");
  });

  it("快照與身分紀錄不受原輸入後續變動影響，回傳的巢狀內容也已凍結", () => {
    const draft = fixture();
    const actor = { ...submitter };
    const review = expectReview(submitForReview(draft, actor, SUBMITTED_AT));
    draft.to.push("changed@example.invalid");
    draft.attachments[0].version = "v99";
    draft.vendor.name = "修改後的虛構廠商";
    draft.event.fields.venue = "修改後的虛構場地";
    draft.links[0].resourceVersion = "v99";
    actor.id = "changed-member";
    assert.deepEqual(review.snapshot, fixture());
    assert.equal(review.submission.submittedBy, submitter.id);
    for (const value of [review, review.snapshot, review.submission, review.snapshot.to, review.snapshot.vendor,
      review.snapshot.event, review.snapshot.event.fields, review.snapshot.attachments, review.snapshot.attachments[0],
      review.snapshot.links, review.snapshot.links[0], approved().approval]) {
      assert.ok(Object.isFrozen(value));
    }
    assert.throws(() => { (review.snapshot as Mutable<ReviewDraft>).body = "不應改動快照"; }, TypeError);
  });

  for (const value of ["", "2026-11-20T14:00:00", "2026-02-30T14:00:00Z", "不是時間"]) {
    it(`送審與核准時間都須有效且有時區：${JSON.stringify(value)}`, () => {
      expectFailure(submitForReview(fixture(), submitter, value), "invalid_time");
      expectFailure(approveReview(pending(), fixture(), reviewer, value), "invalid_time");
    });
  }

  it("依實際時間比較不同時區，禁止核准早於送審，不自行新增核准有效天數", () => {
    expectFailure(approveReview(pending(), fixture(), reviewer, "2026-11-20T05:59:59Z"), "invalid_time");
    assert.equal(expectReview(approveReview(pending(), fixture(), reviewer, "2026-11-20T06:00:00Z")).status, "approved");
    assert.equal(expectReview(approveReview(pending(), fixture(), reviewer, "2026-12-20T14:00:00+08:00")).status, "approved");
  });

  const malformedDrafts: readonly [string, (draft: Mutable<ReviewDraft>) => void][] = [
    ["空版本", (d) => { d.revision = " "; }],
    ["空主旨", (d) => { d.subject = " "; }],
    ["主旨換行", (d) => { d.subject = "虛構\n主旨"; }],
    ["空內文", (d) => { d.body = "\n"; }],
    ["缺收件人", (d) => { d.to = []; }],
    ["稀疏收件人", (d) => { delete d.to[0]; }],
    ["缺 Cc 結構", (d) => { delete (d as Partial<Mutable<ReviewDraft>>).cc; }],
    ["缺附件版本", (d) => { delete (d.attachments[0] as Partial<Mutable<ReviewDraft>["attachments"][number]>).version; }],
    ["缺連結版本", (d) => { delete (d.links[0] as Partial<Mutable<ReviewDraft>["links"][number]>).resourceVersion; }],
  ];
  for (const [label, change] of malformedDrafts) {
    it(`不以缺漏結構建立送審或核准紀錄：${label}`, () => {
      const draft = fixture(); change(draft);
      expectFailure(submitForReview(draft, submitter, SUBMITTED_AT), "invalid_draft");
      expectFailure(reconcileReview(approved(), draft), "invalid_draft");
      expectFailure(approveReview(pending(), draft, reviewer, APPROVED_AT), "invalid_draft");
    });
  }

  it("空附件與連結清單可明確表示沒有項目，不代替寄前檢核決定是否必填", () => {
    const draft = { ...fixture(), attachments: [], links: [] };
    assert.equal(approved(draft).status, "approved");
  });

  it("缺少或自相矛盾的歷史紀錄不能視為核准", () => {
    const source = approved();
    const invalid = [
      { ...source, status: "unknown" },
      { ...source, approval: null },
      { ...source, approval: { ...source.approval, draftRevision: "r99" } },
      { ...source, approval: { ...source.approval, reviewerId: "" } },
      { ...source, approval: { ...source.approval, approvedAt: "2026-11-20T05:00:00Z" } },
      { ...pending(), approval: source.approval },
      { ...source, submission: null },
    ];
    for (const review of invalid) {
      expectFailure(reconcileReview(review as MailReview, fixture()), "invalid_review");
    }
  });

  it("錯誤不回傳完整信件或原始例外，重複核對也不修改已核准紀錄", () => {
    const draft = fixture();
    draft.body = "僅供離線測試的非公開完整信件內容";
    const review = approved(draft);
    assert.deepEqual(reconcileReview(review, draft), reconcileReview(review, draft));
    const result = approveReview(pending(draft), { ...draft, body: "另一段非公開測試內容" }, reviewer, APPROVED_AT);
    expectFailure(result, "draft_changed");
    for (const privateText of [draft.body, "另一段非公開測試內容", draft.to[0]]) {
      assert.equal(JSON.stringify(result).includes(privateText), false);
    }
    assert.equal("cause" in result, false);
  });
});
