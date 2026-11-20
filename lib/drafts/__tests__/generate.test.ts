import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  generateDraft,
  inspectDraftTemplate,
  type DraftFieldValues,
  type DraftGenerationResult,
  type DraftTemplate,
} from "../index.ts";

const invitation: DraftTemplate = Object.freeze({
  kind: "initial_invitation",
  subject: "{{活動名稱}}合作邀約｜{{廠商名稱}}",
  body: "{{聯絡窗口}}您好：\n我們將於{{活動日期}}舉辦{{活動名稱}}，希望洽談{{合作需求}}。",
});
const fields = Object.freeze({
  活動名稱: "示範社團成果展",
  廠商名稱: "示範文具公司",
  聯絡窗口: "示範窗口",
  活動日期: "2026-12-20",
  合作需求: "活動用品贊助",
});

function expectFailure(result: DraftGenerationResult) {
  assert.equal(result.ok, false);
  assert.equal("draft" in result, false, "失敗時不能取得部分草稿");
  assert.equal("usedFields" in result, false);
  return result.issues;
}

describe("草稿生成核心（完全離線）", () => {
  it("將窗口、日期、合作需求填進初次邀約公版，永遠產生未審核草稿", () => {
    const result = generateDraft(invitation, fields);
    assert.deepEqual(result, {
      ok: true,
      draft: {
        kind: "initial_invitation",
        subject: "示範社團成果展合作邀約｜示範文具公司",
        body: "示範窗口您好：\n我們將於2026-12-20舉辦示範社團成果展，希望洽談活動用品贊助。",
        status: "draft",
        perMessageApproval: "not_approved",
      },
      usedFields: ["活動名稱", "廠商名稱", "聯絡窗口", "活動日期", "合作需求"],
    });
  });

  it("支援追蹤公版，但不自行選擇公版或推測追蹤資格", () => {
    const result = generateDraft({
      kind: "follow_up", subject: "Re: {{活動名稱}}", body: "想請問{{廠商名稱}}是否方便回覆？",
    }, fields);
    assert.ok(result.ok);
    assert.equal(result.draft.kind, "follow_up");
    assert.equal(result.draft.perMessageApproval, "not_approved");
    assert.equal(result.draft.body, "想請問示範文具公司是否方便回覆？");
  });

  it("先列出不重複的必填欄位，重複引用及括號內空白不影響替換", () => {
    const template: DraftTemplate = {
      kind: "initial_invitation", subject: "{{ vendor_name }}／{{vendor_name}}",
      body: "{{活動2}}：{{vendor_name}}，{{活動2}}",
    };
    assert.deepEqual(inspectDraftTemplate(template), { ok: true, requiredFields: ["vendor_name", "活動2"] });
    const result = generateDraft(template, { vendor_name: "示範廠商", 活動2: "示範活動" });
    assert.ok(result.ok);
    assert.equal(result.draft.subject, "示範廠商／示範廠商");
    assert.equal(result.draft.body, "示範活動：示範廠商，示範活動");
  });

  it("保留文字、emoji、前後空白及內文換行，不做額外改寫", () => {
    const result = generateDraft({
      kind: "initial_invitation", subject: "  {{名稱}} 📣  ", body: "開頭\r\n{{需求}}\n結尾 {備註}",
    }, { 名稱: " 示範名稱 ", 需求: " 第一行\n第二行 " });
    assert.ok(result.ok);
    assert.equal(result.draft.subject, "   示範名稱  📣  ");
    assert.equal(result.draft.body, "開頭\r\n 第一行\n第二行 \n結尾 {備註}");
  });

  it("接受沒有變數的公版，忽略未引用的資料", () => {
    const values = Object.defineProperty({}, "未引用", {
      get() { throw new Error("不應讀取未引用資料"); },
    });
    const result = generateDraft({ kind: "initial_invitation", subject: "示範主旨", body: "示範內文" }, values);
    assert.ok(result.ok);
    assert.deepEqual(result.usedFields, []);
  });

  it("一次回報所有缺漏欄位，不以多次引用重複回報，也不產生部分草稿", () => {
    const issues = expectFailure(generateDraft(invitation, { 活動名稱: fields.活動名稱 }));
    assert.deepEqual(issues.map(({ code, field }) => ({ code, field })), [
      { code: "missing_field_value", field: "廠商名稱" },
      { code: "missing_field_value", field: "聯絡窗口" },
      { code: "missing_field_value", field: "活動日期" },
      { code: "missing_field_value", field: "合作需求" },
    ]);
  });

  for (const value of [undefined, "", " \n\t "]) {
    it(`空值回報缺資料：${JSON.stringify(value)}`, () => {
      const issues = expectFailure(generateDraft(invitation, { ...fields, 合作需求: value }));
      assert.equal(issues[0].code, "missing_field_value");
      assert.equal(issues[0].field, "合作需求");
    });
  }

  for (const value of [null, 0, false, ["資料"], { toString() { throw new Error("不應轉型"); } }]) {
    it(`非文字資料回報格式錯誤，不強制轉型：${typeof value}`, () => {
      const values = { ...fields, 合作需求: value } as unknown as DraftFieldValues;
      assert.equal(expectFailure(generateDraft(invitation, values))[0].code, "invalid_field_value");
    });
  }

  it("原型鏈的同名欄位不算已提供；getter 也不執行", () => {
    const template: DraftTemplate = { kind: "follow_up", subject: "示範", body: "{{constructor}} {{toString}} {{需求}}" };
    const values = Object.create({ constructor: "繼承值", toString: "繼承值" }) as DraftFieldValues;
    Object.defineProperty(values, "需求", { get() { throw new Error("不應執行 getter"); } });
    assert.deepEqual(expectFailure(generateDraft(template, values)).map(({ code }) => code), [
      "missing_field_value", "missing_field_value", "invalid_field_value",
    ]);
  });

  it("替換內容不再解析，也不執行程式或特殊替換符號", () => {
    const value = "{{未提供}} $& $1 ${expression} <b>純文字</b>";
    const result = generateDraft({ kind: "follow_up", subject: "{{名稱}}", body: "{{名稱}}" }, { 名稱: value });
    assert.ok(result.ok);
    assert.equal(result.draft.subject, value);
    assert.equal(result.draft.body, value);
    assert.deepEqual(result.usedFields, ["名稱"]);
  });

  for (const text of ["{{", "}}", "{{}}", "{{ }}", "{{廠商名稱}", "{{a.b}}", "{{a + b}}", "{{1name}}", "{{{{名稱}}}}", "{{名稱}}}"]) {
    it(`公版語法錯誤不產生草稿：${text}`, () => {
      const template: DraftTemplate = { kind: "follow_up", subject: "示範主旨", body: text };
      const inspection = inspectDraftTemplate(template);
      assert.ok(!inspection.ok);
      assert.deepEqual(generateDraft(template, {}), inspection);
      assert.equal(inspection.issues[0].code, "invalid_placeholder");
      assert.equal(inspection.issues[0].part, "body");
    });
  }

  it("空白主旨、內文與未知公版類型都回報，不當作成功", () => {
    const template = { kind: "other", subject: "  ", body: "\n" } as unknown as DraftTemplate;
    assert.deepEqual(expectFailure(generateDraft(template, {})).map(({ code, part }) => [code, part]), [
      ["invalid_kind", "kind"], ["empty_template", "subject"], ["empty_template", "body"],
    ]);
  });

  for (const lineBreak of ["\r", "\n", "\r\n", "\u0085", "\u2028", "\u2029"]) {
    it(`主旨公版與填入的值都不能換行：${JSON.stringify(lineBreak)}`, () => {
      const template: DraftTemplate = { kind: "follow_up", subject: `示範${lineBreak}主旨`, body: "示範內文" };
      assert.equal(expectFailure(generateDraft(template, {}))[0].code, "subject_line_break");
      assert.equal(expectFailure(generateDraft({ ...template, subject: "{{名稱}}" }, {
        名稱: `示範${lineBreak}名稱`,
      }))[0].code, "subject_line_break");
    });
  }

  it("重複執行不改動輸入，修改公版後重新生成仍是未核准草稿", () => {
    const original = generateDraft(invitation, fields);
    assert.deepEqual(generateDraft(invitation, fields), original);
    const changedTemplate = { ...invitation, subject: "修改後的主旨", perMessageApproval: "approved" };
    const changed = generateDraft(changedTemplate, fields);
    assert.ok(changed.ok);
    assert.equal(changed.draft.perMessageApproval, "not_approved");
    assert.equal(changed.draft.status, "draft");
    assert.equal(invitation.subject, "{{活動名稱}}合作邀約｜{{廠商名稱}}");
    assert.equal(fields.合作需求, "活動用品贊助");
  });

  it("錯誤結果不包含完整公版或欄位值", () => {
    const privateText = "僅供離線測試的完整信件內容";
    const privateValue = "僅供離線測試的非公開欄位值";
    const result = generateDraft({ kind: "follow_up", subject: "{{名稱}}", body: `${privateText} {{缺少欄位}}` }, {
      名稱: privateValue,
    });
    expectFailure(result);
    assert.equal(JSON.stringify(result).includes(privateText), false);
    assert.equal(JSON.stringify(result).includes(privateValue), false);
  });
});
