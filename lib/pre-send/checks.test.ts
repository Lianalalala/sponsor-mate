import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkAttachments, checkEvent, checkLinks, checkPreSend, checkRecipient, checkVendor,
  type CategoryResult, type CheckStatus, type PreSendInput,
} from "./index.ts";

type Mutable<T> = T extends readonly (infer U)[] ? Mutable<U>[] :
  T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;

// 全部為虛構資料與固定時間；證據只是測試資料，不是真正的後端驗證。
function fixture(): Mutable<PreSendInput> {
  const vendor = { id: "vendor-test", name: "虛構青丘商行" };
  const event = { id: "event-test", name: "虛構社團成果展", date: "2026-11-20", fields: { venue: "虛構會館" } };
  const file = { fileRef: "proposal-test", version: "v3" };
  const url = "https://files.example.invalid/proposal";
  return {
    draft: { id: "draft-test", revision: "r1", to: ["contact@example.invalid"], cc: [], bcc: [],
      contactId: "contact-test", vendor: { ...vendor }, event: { ...event, fields: { ...event.fields } },
      attachments: [{ ...file }], links: [{ url, resourceVersion: "resource-v3" }] },
    references: { revision: "ref1", vendor: { status: "confirmed", value: { ...vendor } },
      contact: { status: "confirmed", value: { id: "contact-test", vendorId: vendor.id, email: "contact@example.invalid", validity: "current" } },
      event: { status: "confirmed", value: { ...event, fields: { ...event.fields } } } },
    policy: { requiredEventFields: ["venue"], attachments: { requirement: "required", expected: { status: "confirmed", value: [{ ...file }] } }, linksRequired: true },
    evidence: { source: "trusted_server", links: [{ url, resourceVersion: "resource-v3", draftId: "draft-test", draftRevision: "r1",
      referenceRevision: "ref1", recipientEmail: "contact@example.invalid", attachmentSnapshot: [{ ...file }],
      reviewerId: "reviewer-test", checkedAt: "2026-11-13T10:00:00+08:00", availability: "reachable", access: "allowed" }] },
  };
}

function expectCheck(check: (input: PreSendInput) => CategoryResult, data: PreSendInput, status: CheckStatus, code?: string) {
  const result = check(data);
  assert.equal(result.status, status, JSON.stringify(result.findings));
  if (code) assert.ok(result.findings.some((item) => item.code === code), code);
  for (const item of result.findings) {
    assert.ok(item.code && item.message && item.requiredAction);
  }
}

describe("收件人檢核", () => {
  it("單一 To 與目前已確認的廠商窗口一致", () => expectCheck(checkRecipient, fixture(), "pass"));
  it("地址可去首尾空白、網域大小寫不影響比對", () => {
    const data = fixture(); data.draft.to = [" contact@EXAMPLE.INVALID "];
    expectCheck(checkRecipient, data, "pass");
  });
  for (const address of ["", "not-email", "a@@example.invalid", ".a@example.invalid", "a..b@example.invalid", "a@-example.invalid", "a@example.invalid\r\nBcc:other@example.invalid", "窗口 <contact@example.invalid>"]) {
    it(`不從無效或不支援的地址自動擷取收件人：${JSON.stringify(address)}`, () => {
      const data = fixture(); data.draft.to = [address];
      expectCheck(checkRecipient, data, "block", "recipient.invalid_email");
    });
  }
  it("缺少 To 必須阻擋", () => {
    const data = fixture(); data.draft.to = [];
    expectCheck(checkRecipient, data, "block", "recipient.missing");
  });
  for (const field of ["cc", "bcc"] as const) {
    it(`${field} 非空時明確回報不支援`, () => {
      const data = fixture(); data.draft[field] = ["other@example.invalid"];
      expectCheck(checkRecipient, data, "block", "recipient.unsupported_copy");
    });
  }
  for (const to of [["contact@example.invalid", "other@example.invalid"], ["contact@example.invalid,other@example.invalid"], ["contact@example.invalid;other@example.invalid"]]) {
    it(`多位 To 不可被忽略：${to.join(" / ")}`, () => {
      const data = fixture(); data.draft.to = to;
      expectCheck(checkRecipient, data, "block", "recipient.unsupported_multiple");
    });
  }
  it("缺少 Cc／Bcc 結構不能默認為空", () => {
    const data = fixture(); delete (data.draft as Partial<typeof data.draft>).bcc;
    expectCheck(checkRecipient, data, "needs_review", "recipient.routing_unknown");
  });
  it("不改 local-part、+tag 或點來湊成相同地址", () => {
    for (const address of ["Contact@example.invalid", "contact+new@example.invalid", "con.tact@example.invalid"]) {
      const data = fixture(); data.draft.to = [address];
      expectCheck(checkRecipient, data, "block", "recipient.email_mismatch");
    }
  });
  for (const change of ["email", "contactId", "vendorId", "replaced"] as const) {
    it(`已確認的窗口資訊不符時阻擋：${change}`, () => {
      const data = fixture();
      if (change === "email") data.draft.to = ["other@example.invalid"];
      if (change === "contactId") data.draft.contactId = "other-contact";
      if (change === "vendorId") data.references!.contact.value!.vendorId = "other-vendor";
      if (change === "replaced") data.references!.contact.value!.validity = "replaced";
      expectCheck(checkRecipient, data, "block");
    });
  }
  it("窗口有效性未知時不能通過", () => {
    const data = fixture(); data.references!.contact.value!.validity = "unknown";
    expectCheck(checkRecipient, data, "needs_review", "recipient.validity_unknown");
  });
  it("窗口基準 Email 無效時不能默認通過", () => {
    const data = fixture(); data.references!.contact.value!.email = "bad";
    expectCheck(checkRecipient, data, "needs_review", "recipient.reference_unknown");
  });
});

describe("廠商名稱檢核", () => {
  it("正確正式名稱可通過", () => expectCheck(checkVendor, fixture(), "pass"));
  it("只容許首尾空白差異，不自動推測別名", () => {
    const data = fixture(); data.draft.vendor.name = " 虛構青丘商行 ";
    expectCheck(checkVendor, data, "pass");
    data.draft.vendor.name = "青丘";
    expectCheck(checkVendor, data, "block", "vendor.name_mismatch");
  });
  it("缺完整名稱時阻擋", () => {
    const data = fixture(); data.draft.vendor.name = " ";
    expectCheck(checkVendor, data, "block", "vendor.missing");
  });
  it("廠商 ID 不符時阻擋", () => {
    const data = fixture(); data.draft.vendor.id = "other-vendor";
    expectCheck(checkVendor, data, "block", "vendor.id_mismatch");
  });
  it("已標確認但基準名稱空白仍不能通過", () => {
    const data = fixture(); data.references!.vendor.value!.name = "";
    expectCheck(checkVendor, data, "needs_review", "vendor.reference_unknown");
  });
});

describe("活動資訊檢核", () => {
  it("活動固定欄位與設定指定的場地均一致", () => expectCheck(checkEvent, fixture(), "pass"));
  for (const field of ["id", "name", "date"] as const) {
    it(`活動 ${field} 缺少時阻擋`, () => {
      const data = fixture(); data.draft.event[field] = null;
      expectCheck(checkEvent, data, "block", "event.missing_or_invalid");
    });
    it(`活動 ${field} 與已確認資料不符時阻擋`, () => {
      const data = fixture(); data.draft.event[field] = field === "date" ? "2026-11-21" : "different";
      expectCheck(checkEvent, data, "block", `event.${field}_mismatch`);
    });
  }
  it("不接受會滾動的假日期或未約定的日期格式", () => {
    for (const date of ["2026-02-30", "2026/11/20", "2026-11-20T00:00:00Z"]) {
      const data = fixture(); data.draft.event.date = date;
      expectCheck(checkEvent, data, "block", "event.missing_or_invalid");
    }
  });
  it("基準日期無效時回報待確認", () => {
    const data = fixture(); data.references!.event.value!.date = "2026-02-30";
    expectCheck(checkEvent, data, "needs_review", "event.reference_unknown");
  });
  it("其餘欄位是否必填由設定決定", () => {
    const data = fixture(); data.draft.event.fields = {};
    expectCheck(checkEvent, data, "block", "event.required_field_missing");
    data.policy.requiredEventFields = [];
    expectCheck(checkEvent, data, "pass");
  });
  it("必填清單未決時不得默認沒有其他必填", () => {
    const data = fixture(); data.policy.requiredEventFields = null;
    expectCheck(checkEvent, data, "needs_review", "event.requirements_unknown");
  });
  it("非必填但實際帶入的欄位仍須與基準一致", () => {
    const data = fixture(); data.policy.requiredEventFields = []; data.draft.event.fields.venue = "錯誤場地";
    expectCheck(checkEvent, data, "block", "event.field_mismatch");
  });
  it("提供的活動欄位沒有確認基準時需核對", () => {
    const data = fixture(); data.draft.event.fields.extra = "未知資訊";
    expectCheck(checkEvent, data, "needs_review", "event.field_reference_unknown");
  });
  it("已列入寄件資料的選填欄位若未知，不能因非必填就默認通過", () => {
    const data = fixture(); data.policy.requiredEventFields = []; data.draft.event.fields.venue = null;
    expectCheck(checkEvent, data, "needs_review", "event.field_unknown");
    delete data.draft.event.fields.venue;
    expectCheck(checkEvent, data, "pass");
  });
});

describe("附件需求與指定版本", () => {
  it("指定檔案與版本一致可通過", () => expectCheck(checkAttachments, fixture(), "pass"));
  it("required 沒附件時阻擋", () => {
    const data = fixture(); data.draft.attachments = [];
    expectCheck(checkAttachments, data, "block", "attachments.required_missing");
  });
  it("optional 沒附件可以通過，不因有指定版本而強迫附檔", () => {
    const data = fixture(); data.policy.attachments.requirement = "optional"; data.draft.attachments = [];
    expectCheck(checkAttachments, data, "pass");
  });
  for (const withFile of [false, true]) {
    it(`unknown 需求不可自動通過（有附件：${withFile}）`, () => {
      const data = fixture(); data.policy.attachments.requirement = "unknown";
      if (!withFile) data.draft.attachments = [];
      expectCheck(checkAttachments, data, "needs_review", "attachments.requirement_unknown");
    });
  }
  it("沒有指定版本時不比較版本，也不要求填入實際版本", () => {
    const data = fixture(); data.policy.attachments.expected.value![0].version = null;
    for (const actualVersion of [null, "another-version"]) {
      data.draft.attachments[0].version = actualVersion;
      expectCheck(checkAttachments, data, "pass");
    }
  });
  it("有指定版本但實際版本未知時需確認", () => {
    const data = fixture(); data.draft.attachments[0].version = null;
    expectCheck(checkAttachments, data, "needs_review", "attachments.version_unknown");
  });
  it("實際版本已知不符時阻擋，不能用權限證據覆蓋", () => {
    const data = fixture(); data.draft.attachments[0].version = "v2";
    expectCheck(checkAttachments, data, "block", "attachments.version_mismatch");
    assert.equal(checkPreSend(data).status, "block");
  });
  it("缺少指定檔案時阻擋", () => {
    const data = fixture(); data.draft.attachments[0].fileRef = "other-file";
    expectCheck(checkAttachments, data, "block", "attachments.file_missing");
  });
  it("額外未指定附件需要人工確認", () => {
    const data = fixture(); data.draft.attachments.push({ fileRef: "extra-file", version: null });
    expectCheck(checkAttachments, data, "needs_review", "attachments.unexpected");
  });
  it("required 基準為空或有重複識別時不得通過", () => {
    for (const files of [[], [{ fileRef: "proposal-test", version: "v3" }, { fileRef: "proposal-test", version: "v4" }]]) {
      const data = fixture(); data.policy.attachments.expected.value = files;
      expectCheck(checkAttachments, data, "needs_review", "attachments.reference_unknown");
    }
  });
  it("無效附件 metadata 不能默認通過", () => {
    const data = fixture(); data.policy.attachments.requirement = "optional"; data.draft.attachments[0].fileRef = null;
    expectCheck(checkAttachments, data, "needs_review", "attachments.metadata_unknown");
  });
});

describe("連結格式與確認證據", () => {
  it("HTTPS 與相符可信證據可通過，只代表證據檢查", () => expectCheck(checkLinks, fixture(), "pass"));
  for (const url of ["", "https://", "https:example.invalid", "not a url", "https://example.invalid/a b", "javascript:alert(1)", "data:text/plain,test", "file:///test", "ftp://example.invalid/file"]) {
    it(`無效或不支援協定的 URL 阻擋：${url || "空白"}`, () => {
      const data = fixture(); data.draft.links[0].url = url;
      expectCheck(checkLinks, data, "block", "links.invalid_url");
    });
  }
  it("HTTP 即使有有效性與權限證據仍需人工確認", () => {
    const data = fixture(); const url = "http://files.example.invalid/proposal";
    data.draft.links[0].url = url; data.evidence!.links[0].url = url;
    expectCheck(checkLinks, data, "needs_review", "links.http_review");
  });
  it("沒有證據不能以 URL 格式有效取代權限確認", () => {
    const data = fixture(); data.evidence = null;
    expectCheck(checkLinks, data, "needs_review", "links.evidence_missing_or_stale");
  });
  it("前端自報的確認證據不能單獨讓連結通過", () => {
    const data = fixture(); data.evidence!.source = "untrusted";
    expectCheck(checkLinks, data, "needs_review", "links.evidence_missing_or_stale");
  });
  for (const [field, state, expectedStatus, code] of [
    ["availability", "broken", "block", "links.known_broken"],
    ["availability", "unknown", "needs_review", "links.availability_unknown"],
    ["access", "denied", "block", "links.known_denied"],
    ["access", "unknown", "needs_review", "links.access_unknown"],
  ] as const) {
    it(`確認證據 ${field}=${state}`, () => {
      const data = fixture(); Object.assign(data.evidence!.links[0], { [field]: state });
      expectCheck(checkLinks, data, expectedStatus, code);
    });
  }
  it("收件人改變後舊確認不可沿用，即使新窗口基準也已更新", () => {
    const data = fixture(); data.draft.to = ["new@example.invalid"]; data.references!.contact.value!.email = "new@example.invalid";
    expectCheck(checkRecipient, data, "pass");
    expectCheck(checkLinks, data, "needs_review", "links.evidence_missing_or_stale");
    assert.equal(checkPreSend(data).status, "needs_review");
  });
  it("附件版本改變後舊確認不可沿用，即使新附件已符合新的指定版本", () => {
    const data = fixture(); data.draft.attachments[0].version = "v4"; data.policy.attachments.expected.value![0].version = "v4";
    expectCheck(checkAttachments, data, "pass");
    expectCheck(checkLinks, data, "needs_review", "links.evidence_missing_or_stale");
  });
  for (const field of ["draftId", "draftRevision", "referenceRevision", "url", "resourceVersion"] as const) {
    it(`確認證據 ${field} 不符時需重新確認`, () => {
      const data = fixture(); data.evidence!.links[0][field] = field === "url" ? "https://other.example.invalid/file" : "outdated";
      expectCheck(checkLinks, data, "needs_review", "links.evidence_missing_or_stale");
    });
  }
  for (const [field, value] of [["reviewerId", ""], ["checkedAt", ""], ["checkedAt", "2026-02-30T00:00:00Z"]] as const) {
    it(`確認證據缺人員或有效時間不能通過：${field}=${value}`, () => {
      const data = fixture(); data.evidence!.links[0][field] = value;
      expectCheck(checkLinks, data, "needs_review", "links.evidence_missing_or_stale");
    });
  }
  it("同時有適用的允許與拒絕證據時不能任選允許", () => {
    const data = fixture(); data.evidence!.links.push({ ...data.evidence!.links[0], access: "denied" });
    expectCheck(checkLinks, data, "block", "links.known_denied");
  });
  it("純附件順序改變不會假稱附件版本改變", () => {
    const data = fixture(); const extra = { fileRef: "second-file", version: "v1" };
    data.draft.attachments.push({ ...extra }); data.policy.attachments.expected.value!.push({ ...extra });
    data.evidence!.links[0].attachmentSnapshot.push({ ...extra }); data.draft.attachments.reverse();
    expectCheck(checkLinks, data, "pass");
  });
  it("連結選用且清單為空可通過；必填但缺少則阻擋；未決則人工確認", () => {
    const data = fixture(); data.draft.links = []; data.policy.linksRequired = false;
    expectCheck(checkLinks, data, "pass");
    data.policy.linksRequired = true; expectCheck(checkLinks, data, "block", "links.required_missing");
    data.policy.linksRequired = null; expectCheck(checkLinks, data, "needs_review", "links.requirement_unknown");
  });
});

describe("基準缺漏、結果彙整與純函式邊界", () => {
  for (const field of ["contact", "vendor", "event"] as const) {
    for (const missingValue of [false, true]) {
      it(`${field} 基準未確認或缺少時不可默認通過（缺少：${missingValue}）`, () => {
        const data = fixture();
        if (missingValue) data.references![field].value = null;
        else data.references![field].status = "unknown";
        assert.equal(checkPreSend(data).status, "needs_review");
      });
    }
  }
  it("整份基準缺漏時仍回報待確認，不宣稱通過", () => {
    const data = fixture(); data.references = null;
    const result = checkPreSend(data);
    assert.equal(result.status, "needs_review");
    assert.ok(result.findings.some((item) => item.code === "context.version_unknown"));
  });
  it("即使標為 confirmed，活動基準 value 根本缺少也不能通過", () => {
    const data = fixture(); const base = data.references!.event;
    delete (base as Partial<typeof base>).value;
    expectCheck(checkEvent, data, "needs_review", "event.reference_unknown");
  });
  it("無效的活動必填設定不能當成已決定無其他必填", () => {
    const data = fixture(); data.policy.requiredEventFields = [""];
    expectCheck(checkEvent, data, "needs_review", "event.requirements_unknown");
  });
  it("缺少附件或連結清單時不能假設為空清單", () => {
    const missingAttachments = fixture(); delete (missingAttachments.draft as Partial<typeof missingAttachments.draft>).attachments;
    expectCheck(checkAttachments, missingAttachments, "needs_review", "attachments.list_unknown");
    const missingLinks = fixture(); delete (missingLinks.draft as Partial<typeof missingLinks.draft>).links;
    expectCheck(checkLinks, missingLinks, "needs_review", "links.list_unknown");
  });
  it("明確選用附件、不要求連結且兩者皆無時，不需要虛構確認證據", () => {
    const data = fixture(); data.policy.attachments.requirement = "optional"; data.policy.linksRequired = false;
    data.draft.attachments = []; data.draft.links = []; data.evidence = null;
    assert.equal(checkPreSend(data).status, "pass");
  });
  it("指定附件基準未確認時不能默認通過", () => {
    const data = fixture(); data.policy.attachments.expected.status = "unknown";
    expectCheck(checkAttachments, data, "needs_review", "attachments.reference_unknown");
  });
  it("阻擋優先於人工確認；各項都保留原因與必要行動", () => {
    const data = fixture(); data.draft.to = []; data.references!.vendor.status = "unknown";
    const result = checkPreSend(data);
    assert.equal(result.status, "block");
    assert.ok(result.counts.block > 0 && result.counts.needs_review > 0);
    assert.ok(result.findings.every((item) => item.code && item.message && item.requiredAction));
  });
  it("資料全正確也只代表結構化資料，不代表正文已驗證、人工核准或允許寄信", () => {
    const result = checkPreSend(fixture());
    assert.equal(result.status, "pass");
    assert.deepEqual(result.counts, { pass: 5, needs_review: 0, block: 0 });
    assert.equal(result.validationScope, "structured_data_only");
    assert.equal(result.finalMessageValidation, "not_checked");
    assert.equal(result.perMessageApproval, "not_checked");
    assert.equal("canSend" in result, false);
  });
  it("缺少信件版本時不能把檢核結果當成可沿用的確認", () => {
    const data = fixture(); data.draft.revision = "";
    const result = checkPreSend(data);
    assert.equal(result.status, "needs_review");
    assert.ok(result.findings.some((item) => item.code === "context.version_unknown"));
  });
  it("凍結輸入仍可運作，重複呼叫不修改輸入", () => {
    function freeze<T>(value: T): T {
      if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
      return value;
    }
    const data = freeze(fixture()), before = JSON.stringify(data);
    assert.deepEqual(checkPreSend(data), checkPreSend(data));
    assert.equal(JSON.stringify(data), before);
  });
});
