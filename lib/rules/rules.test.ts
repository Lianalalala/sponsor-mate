import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  calendarDaysBetween, classifyInvitation, countSuccessfulSends, daysSinceLastSuccessfulSend,
  evaluateDailyQuota, evaluateFollowUp, toTaipeiDate,
  type Correspondence, type FollowUpInput, type HistoryInput, type MailRecord,
} from "./index.ts";

const now = "2026-11-13T12:00:00+08:00";
const scope = { clubId: "club-A", vendorId: "vendor-A", eventId: "event-A" };
const correspondence: Correspondence = {
  ...scope, id: "relation-A", contactStatus: "已寄出・尚未回覆", processingDecision: "continue",
};
// 3 天、2 次只用於測試，不是產品預設值。
const settings = { intervalDays: 3, maxFollowUps: 2 };
const mail = (id: string, changes: Partial<MailRecord> = {}): MailRecord => ({
  id, clubId: scope.clubId, correspondenceId: correspondence.id, eventId: scope.eventId,
  direction: "寄出", kind: "首次邀約", status: "成功",
  sentAt: "2026-11-10T12:00:00+08:00", gmailMessageId: `offline-message-${id}`, ...changes,
});
const input = (mails: readonly MailRecord[] = [], changes: Partial<HistoryInput> = {}): HistoryInput => ({
  scope, correspondences: [correspondence], mails, ...changes,
});
const followUp = (changes: Partial<FollowUpInput> = {}): FollowUpInput => ({
  ...input([mail("first")]), now, settings, vendorStopContact: false, hasUnhandledReply: false, ...changes,
});
const quota = (mails: readonly MailRecord[], currentTime = now, clubId = scope.clubId) =>
  evaluateDailyQuota({ clubId, mails, now: currentTime });
const todayMails = (count: number) => Array.from({ length: count }, (_, i) =>
  mail(`today-${i}`, { sentAt: "2026-11-13T09:00:00+08:00" }));
const reasonCodes = (result: ReturnType<typeof evaluateFollowUp>) => result.reasons.map((r) => r.code);

describe("台灣日曆日期", () => {
  it("UTC 尚未換日，台灣已換日", () => {
    assert.equal(toTaipeiDate("2026-11-12T16:00:00Z"), "2026-11-13");
    assert.equal(toTaipeiDate("2026-11-12T15:59:59Z"), "2026-11-12");
  });
  it("午夜前後相差兩分鐘仍是 1 個日曆天", () => {
    assert.equal(calendarDaysBetween("2026-11-12T23:59:00+08:00", "2026-11-13T00:01:00+08:00"), 1);
  });
  it("同一天相差多小時仍是 0 天", () => {
    assert.equal(calendarDaysBetween("2026-11-13T00:01:00+08:00", now), 0);
  });
  it("不同時區表示同一時刻，得到相同台灣日期", () => {
    assert.equal(toTaipeiDate("2026-11-13T04:00:00Z"), toTaipeiDate(now));
    assert.equal(calendarDaysBetween("2026-11-13T04:00:00Z", now), 0);
  });
  it("跨月、跨年及閏年不以日期字串相減", () => {
    assert.equal(calendarDaysBetween("2026-12-31T23:00:00+08:00", "2027-01-01T01:00:00+08:00"), 1);
    assert.equal(calendarDaysBetween("2024-02-28T12:00:00+08:00", "2024-03-01T12:00:00+08:00"), 2);
  });
  for (const value of ["", "bad", "2026-11-13", "2026-11-13T12:00:00", "2026-02-30T12:00:00Z",
    "2026-13-01T12:00:00Z", "2026-11-13T24:00:00Z", "2026-11-13T12:00:00+24:00"]) {
    it(`拒絕不明確或不合法的時間：${value || "空白"}`, () => {
      assert.equal(toTaipeiDate(value), null);
      assert.equal(calendarDaysBetween(value, now), null);
    });
  }
});

describe("成功寄件與初次邀約", () => {
  it("沒有任何信件：零成功、無最後寄件時間、屬初次邀約", () => {
    const history = countSuccessfulSends(input());
    assert.equal(history.successCount, 0);
    assert.equal(history.lastSuccessfulSentAt, null);
    assert.equal(daysSinceLastSuccessfulSend({ ...input(), now }).daysSince, null);
    assert.equal(classifyInvitation(input()).classification, "initial_invitation");
  });
  it("只計成功外寄，不計草稿、失敗、待確認、寄送中或補登來信", () => {
    const mails = [mail("ok"), ...(["未寄送", "失敗", "待確認", "寄送中"] as const)
      .map((status) => mail(status, { status, gmailMessageId: null, sentAt: null })),
    mail("reply", { direction: "收到（人工補登）", kind: "回覆補登", status: "不適用（補登回覆）",
      gmailMessageId: null, sentAt: null })];
    const history = countSuccessfulSends(input(mails));
    assert.equal(history.successCount, 1);
    assert.equal(history.unresolvedCount, 2);
    assert.deepEqual(history.issues, []);
  });
  it("只有失敗或草稿不構成已成功初寄", () => {
    const mails = [mail("draft", { status: "未寄送", gmailMessageId: null }),
      mail("failed", { status: "失敗", gmailMessageId: null })];
    assert.equal(classifyInvitation(input(mails)).classification, "initial_invitation");
  });
  for (const status of ["寄送中", "待確認"] as const) {
    it(`只有${status}也必須先核對，不能當成可安全初寄`, () => {
      assert.equal(classifyInvitation(input([mail("pending", { status, gmailMessageId: null })])).classification, "needs_review");
    });
  }
  it("有成功紀錄後屬後續聯絡，與信件陣列順序無關", () => {
    const old = mail("old", { sentAt: "2026-11-01T12:00:00+08:00" });
    const newer = mail("new", { kind: "催信" });
    const a = countSuccessfulSends(input([newer, old]));
    const b = countSuccessfulSends(input([old, newer]));
    assert.deepEqual(a, b);
    assert.equal(a.lastSuccessfulSentAt, newer.sentAt);
    assert.equal(a.followUpCount, 1);
    assert.equal(classifyInvitation(input([old])).classification, "subsequent_contact");
  });
  it("同一信件 ID 或相同 Message ID 的相同證據只計一次", () => {
    const first = mail("first");
    for (const records of [[first, { ...first }], [first, { ...first, id: "duplicate-row" }]]) {
      const history = countSuccessfulSends(input(records));
      assert.equal(history.successCount, 1);
      assert.deepEqual(history.issues, []);
      assert.equal(quota(records).requiresReconciliation, false);
    }
  });
  it("相同識別碼的狀態矛盾須核對，不採任一列作準", () => {
    const first = mail("first");
    const history = input([first, { ...first, status: "待確認" }]);
    assert.equal(classifyInvitation(history).classification, "needs_review");
    assert.ok(countSuccessfulSends(history).issues.some((i) => i.code === "conflicting_record"));
    assert.equal(quota(history.mails).shouldPause, true);
  });
  it("成功缺 Message ID 不當成可信的零寄件而允許重寄", () => {
    const history = input([mail("missing", { gmailMessageId: null })]);
    assert.equal(countSuccessfulSends(history).successCount, 0);
    assert.equal(classifyInvitation(history).classification, "needs_review");
    assert.equal(quota(history.mails).shouldPause, true);
  });
  it("有成功證據但缺時間：總次數仍計入，天數及每日額度須核對", () => {
    const history = input([mail("missing-time", { sentAt: null })]);
    assert.equal(countSuccessfulSends(history).successCount, 1);
    assert.equal(daysSinceLastSuccessfulSend({ ...history, now }).daysSince, null);
    assert.equal(quota(history.mails).requiresReconciliation, true);
  });
  it("未來成功時間即使與現在同一天，也不能推斷可催信", () => {
    const data = input([mail("future", { sentAt: "2026-11-13T12:01:00+08:00" })]);
    const result = daysSinceLastSuccessfulSend({ ...data, now });
    assert.equal(result.daysSince, null);
    assert.ok(result.issues.some((i) => i.code === "future_time"));
    assert.equal(quota(data.mails).shouldPause, true);
  });
});

describe("時間去重（timestamp-dedup）", () => {
  const utc = mail("utc", { sentAt: "2026-11-10T04:00:00Z" });
  const taipei = { ...utc, id: "taipei", sentAt: "2026-11-10T12:00:00+08:00" };

  it("相同 Message ID、同一時刻的 Z／+08:00 表示只計 1 次", () => {
    // 同時涵蓋依信件 ID 及依 Message ID 去重，且不受紀錄順序影響。
    for (const id of [utc.id, taipei.id]) {
      const duplicate = { ...taipei, id };
      for (const mails of [[utc, duplicate], [duplicate, utc]]) {
        const history = countSuccessfulSends(input(mails));
        assert.equal(history.successCount, 1);
        assert.equal(history.followUpCount, 0);
        assert.deepEqual(history.issues, []);
        assert.equal(daysSinceLastSuccessfulSend({ ...input(mails), now }).daysSince, 3);
        assert.equal(evaluateFollowUp(followUp({ mails })).recommended, true);
        assert.equal(quota(mails).requiresReconciliation, false);
      }
    }
  });

  it("相同 Message ID 即使只差 1 秒，仍回報 conflicting_record", () => {
    for (const id of [utc.id, taipei.id]) {
      const different = { ...taipei, id, sentAt: "2026-11-10T12:00:01+08:00" };
      for (const mails of [[utc, different], [different, utc]]) {
        assert.ok(countSuccessfulSends(input(mails)).issues.some((i) => i.code === "conflicting_record"));
        assert.equal(classifyInvitation(input(mails)).classification, "needs_review");
        assert.equal(evaluateFollowUp(followUp({ mails })).recommended, false);
        assert.equal(quota(mails).shouldPause, true);
      }
    }
  });

  for (const sentAt of [null, "bad", "2026-02-30T12:00:00Z"]) {
    it(`相同 Message ID 的有效與無效時間不可視為一致：${sentAt}`, () => {
      const invalid = { ...taipei, sentAt };
      for (const mails of [[utc, invalid], [invalid, utc]]) {
        assert.ok(countSuccessfulSends(input(mails)).issues.some((i) => i.code === "conflicting_record"));
        assert.equal(classifyInvitation(input(mails)).classification, "needs_review");
        assert.equal(evaluateFollowUp(followUp({ mails })).recommended, false);
        assert.equal(quota(mails).requiresReconciliation, true);
        assert.equal(quota(mails).shouldPause, true);
      }
    });
  }

  it("兩筆時間都無效時仍須核對，不因 parseInstant 都回 null 而放行", () => {
    for (const [firstTime, secondTime] of [[null, null], ["bad", "bad"], ["bad", "other-bad"]]) {
      const mails = [{ ...utc, sentAt: firstTime }, { ...taipei, sentAt: secondTime }];
      assert.ok(countSuccessfulSends(input(mails)).issues.length > 0);
      assert.equal(daysSinceLastSuccessfulSend({ ...input(mails), now }).daysSince, null);
      assert.equal(evaluateFollowUp(followUp({ mails })).recommended, false);
      assert.equal(quota(mails).shouldPause, true);
      if (firstTime !== secondTime) {
        assert.ok(countSuccessfulSends(input(mails)).issues.some((i) => i.code === "conflicting_record"));
      }
    }
  });

  it("29 封加一封使用兩種時區表示的重複紀錄，剛好達每日 30 封上限", () => {
    const last = mail("last", { sentAt: "2026-11-13T01:00:00Z" });
    const duplicate = { ...last, id: "last-duplicate", sentAt: "2026-11-13T09:00:00+08:00" };
    const result = quota([...todayMails(29), last, duplicate]);
    assert.equal(result.sentToday, 30);
    assert.equal(result.remaining, 0);
    assert.equal(result.requiresReconciliation, false);
    assert.equal(result.shouldPause, true);
    assert.deepEqual(result.reasons.map((r) => r.code), ["daily_limit"]);
  });

  it("實際時間相同也不能忽略寄送狀態或信件類型的矛盾", () => {
    for (const duplicate of [{ ...taipei, status: "待確認" as const }, { ...taipei, kind: "催信" as const }]) {
      const mails = [utc, duplicate];
      assert.ok(countSuccessfulSends(input(mails)).issues.some((i) => i.code === "conflicting_record"));
      assert.equal(evaluateFollowUp(followUp({ mails })).recommended, false);
      assert.equal(quota(mails).shouldPause, true);
    }
  });
});

describe("社團、廠商、活動隔離", () => {
  const otherEvent: Correspondence = { ...correspondence, id: "relation-B", eventId: "event-B" };
  const otherVendor: Correspondence = { ...correspondence, id: "relation-C", vendorId: "vendor-B" };
  const foreign: Correspondence = { ...correspondence, clubId: "club-B" };
  const all = [correspondence, otherEvent, otherVendor, foreign];
  it("同廠商不同活動的成功信，不會把新活動變成後續聯絡", () => {
    const mails = [mail("other", { correspondenceId: otherEvent.id, eventId: otherEvent.eventId })];
    assert.equal(classifyInvitation(input(mails, { correspondences: all })).classification, "initial_invitation");
  });
  it("另一活動的拒絕或停止追蹤，不擴大到目前活動", () => {
    const rejected = { ...otherEvent, contactStatus: "已拒絕", processingDecision: "stop" as const };
    const result = evaluateFollowUp(followUp({ correspondences: [correspondence, rejected], mails: [mail("first"),
      mail("other", { correspondenceId: otherEvent.id, eventId: otherEvent.eventId })] }));
    assert.equal(result.recommended, true);
  });
  it("同活動不同廠商不混算", () => {
    const history = countSuccessfulSends(input([mail("other", { correspondenceId: otherVendor.id })], { correspondences: all }));
    assert.equal(history.successCount, 0);
    assert.deepEqual(history.issues, []);
  });
  it("不同社團即使識別碼相同也不混算，未決寄件也不互相阻擋", () => {
    const records = [mail("foreign", { clubId: "club-B" }),
      mail("pending", { clubId: "club-B", status: "待確認", gmailMessageId: null })];
    assert.equal(countSuccessfulSends(input(records, { correspondences: all })).successCount, 0);
    assert.equal(quota(records).shouldPause, false);
  });
  it("④活動 ID 與③不一致，或找不到往來紀錄，須核對", () => {
    for (const record of [mail("wrong-event", { eventId: "event-B" }), mail("orphan", { correspondenceId: "missing" })]) {
      const data = input([record], { correspondences: all });
      assert.equal(classifyInvitation(data).classification, "needs_review");
      assert.ok(countSuccessfulSends(data).issues.some((i) => i.code === "invalid_relation"));
    }
  });
  it("相同 Message ID 分屬不同活動時，不能各算一次", () => {
    const first = mail("first");
    const other = mail("other", { gmailMessageId: first.gmailMessageId, eventId: otherEvent.eventId, correspondenceId: otherEvent.id });
    const data = input([first, other], { correspondences: all });
    assert.equal(classifyInvitation(data).classification, "needs_review");
    assert.equal(quota(data.mails).shouldPause, true);
  });
  it("同廠商與活動出現兩筆③時不任選一筆", () => {
    const data = input([mail("first")], { correspondences: [correspondence, { ...correspondence, id: "duplicate" }] });
    assert.equal(classifyInvitation(data).classification, "needs_review");
  });
});

describe("催信建議", () => {
  it("間隔剛好 3 天可列候選，原因仍提醒逐封核准", () => {
    const result = evaluateFollowUp(followUp());
    assert.equal(result.recommended, true);
    assert.equal(result.history.daysSince, 3);
    assert.match(result.reasons[0].message, /人工逐封核准/);
  });
  it("尚未滿追蹤間隔", () => {
    const result = evaluateFollowUp(followUp({ now: "2026-11-12T23:59:59+08:00" }));
    assert.equal(result.recommended, false);
    assert.ok(reasonCodes(result).includes("interval_not_met"));
  });
  it("尚無成功寄件應先處理首次邀約", () => {
    const result = evaluateFollowUp(followUp({ mails: [] }));
    assert.equal(result.recommended, false);
    assert.ok(reasonCodes(result).includes("no_successful_send"));
  });
  for (const count of [1, 2, 3]) {
    it(`首次邀約加成功催信 ${count} 次：最多只能催 2 次`, () => {
      const records = [mail("first"), ...Array.from({ length: count }, (_, i) => mail(`follow-${i}`, { kind: "催信" }))];
      const result = evaluateFollowUp(followUp({ mails: records }));
      assert.equal(result.history.successCount, count + 1);
      assert.equal(result.history.followUpCount, count);
      assert.equal(result.recommended, count < 2);
    });
  }
  it("其他外寄計入總數與最後時間，但不直接消耗催信次數", () => {
    const result = evaluateFollowUp(followUp({ mails: [mail("first"), mail("other", { kind: "其他外寄" })] }));
    assert.equal(result.history.successCount, 2);
    assert.equal(result.history.followUpCount, 0);
    assert.equal(result.recommended, true);
  });
  it("較新的其他外寄會重算間隔，不能只看首次邀約日期", () => {
    const result = evaluateFollowUp(followUp({ mails: [mail("first"),
      mail("other", { kind: "其他外寄", sentAt: "2026-11-12T12:00:00+08:00" })] }));
    assert.equal(result.history.daysSince, 1);
    assert.equal(result.history.followUpCount, 0);
    assert.equal(result.recommended, false);
    assert.ok(reasonCodes(result).includes("interval_not_met"));
  });
  it("失敗催信不算成功催信，也不重設成功寄件時間", () => {
    const result = evaluateFollowUp(followUp({ mails: [mail("first"),
      mail("failed", { kind: "催信", status: "失敗", gmailMessageId: null, sentAt: null })] }));
    assert.equal(result.history.followUpCount, 0);
    assert.equal(result.history.daysSince, 3);
    assert.equal(result.recommended, true);
  });
  const blockingCases: [string, Partial<FollowUpInput>, string][] = [
    ["停止聯絡", { vendorStopContact: true }, "stop_contact"],
    ["已拒絕", { correspondences: [{ ...correspondence, contactStatus: "已拒絕" }] }, "rejected"],
    ["停止追蹤但仍尚未回覆", { correspondences: [{ ...correspondence, processingDecision: "stop" }] }, "stop_follow_up"],
    ["決策待確認", { correspondences: [{ ...correspondence, processingDecision: "needs_review" }] }, "decision_review"],
    ["有未處理回覆", { hasUnhandledReply: true }, "pending_reply"],
    ["③顯示待處理，不能靠 false 覆蓋", { correspondences: [{ ...correspondence, contactStatus: "已回覆・待處理" }] }, "pending_reply"],
    ["洽談中", { correspondences: [{ ...correspondence, contactStatus: "洽談中" }] }, "not_awaiting_reply"],
    ["已同意合作", { correspondences: [{ ...correspondence, contactStatus: "已同意合作" }] }, "not_awaiting_reply"],
    ["狀態不明", { correspondences: [{ ...correspondence, contactStatus: null }] }, "contact_review"],
    ["寄送中", { mails: [mail("first"), mail("pending", { status: "寄送中", gmailMessageId: null })] }, "unresolved_send"],
  ];
  for (const [label, changes, code] of blockingCases) {
    it(`${label}不得建議催信`, () => {
      const result = evaluateFollowUp(followUp(changes));
      assert.equal(result.recommended, false);
      assert.ok(reasonCodes(result).includes(code as ReturnType<typeof reasonCodes>[number]));
    });
  }
  for (const config of [{ intervalDays: 0, maxFollowUps: 2 }, { intervalDays: -1, maxFollowUps: 2 },
    { intervalDays: 1.5, maxFollowUps: 2 }, { intervalDays: 3, maxFollowUps: -1 },
    { intervalDays: 3, maxFollowUps: NaN }, { intervalDays: 3, maxFollowUps: Infinity }]) {
    it(`無效設定不套用隱藏預設值：${JSON.stringify(config)}`, () => {
      const result = evaluateFollowUp(followUp({ settings: config }));
      assert.equal(result.recommended, false);
      assert.ok(reasonCodes(result).includes("invalid_settings"));
    });
  }
  it("催信上限 0 代表不允許催信", () => {
    assert.equal(evaluateFollowUp(followUp({ settings: { intervalDays: 3, maxFollowUps: 0 } })).recommended, false);
  });
  it("多個阻擋原因一起回報，便於幹部理解", () => {
    const result = evaluateFollowUp(followUp({ vendorStopContact: true, hasUnhandledReply: true }));
    assert.ok(reasonCodes(result).includes("stop_contact"));
    assert.ok(reasonCodes(result).includes("pending_reply"));
  });
  it("漏掉停止聯絡或回覆旗標時不默認為 false", () => {
    for (const changes of [{ vendorStopContact: undefined }, { hasUnhandledReply: undefined }]) {
      const result = evaluateFollowUp({ ...followUp(), ...changes } as unknown as FollowUpInput);
      assert.equal(result.recommended, false);
      assert.ok(reasonCodes(result).includes("data_review"));
    }
  });
  it("目前時間無效時不能產生催信候選", () => {
    const result = evaluateFollowUp(followUp({ now: "2026-11-13" }));
    assert.equal(result.recommended, false);
    assert.ok(reasonCodes(result).includes("data_review"));
  });
});

describe("每社團每日 30 封", () => {
  for (const count of [0, 29, 30, 31]) {
    it(`今日成功 ${count} 封`, () => {
      const result = quota(todayMails(count));
      assert.equal(result.sentToday, count);
      assert.equal(result.remaining, Math.max(0, 30 - count));
      assert.equal(result.shouldPause, count >= 30);
    });
  }
  it("同社團不同活動共同消耗每日額度", () => {
    const records = todayMails(29);
    records.push(mail("other-event", { eventId: "event-B", correspondenceId: "relation-B", sentAt: now }));
    assert.equal(quota(records).sentToday, 30);
    assert.equal(quota(records).shouldPause, true);
  });
  it("台灣午夜準時換日，不以 UTC 日期分組", () => {
    const records = [mail("before", { sentAt: "2026-11-12T15:59:59Z" }),
      mail("after", { sentAt: "2026-11-12T16:00:00Z" })];
    assert.equal(quota(records, "2026-11-13T00:01:00+08:00").sentToday, 1);
    assert.equal(quota(records, "2026-11-13T00:01:00+08:00").remaining, 29);
  });
  it("29 封成功加 1 封待確認：帳面還有 1，但必須暫停", () => {
    const result = quota([...todayMails(29), mail("unknown", { status: "待確認", sentAt: null, gmailMessageId: null })]);
    assert.equal(result.sentToday, 29);
    assert.equal(result.remaining, 1);
    assert.equal(result.unresolvedCount, 1);
    assert.equal(result.shouldPause, true);
    assert.equal(result.requiresReconciliation, true);
  });
  it("昨天留下的未決寄件不會因換日而解除阻擋", () => {
    assert.equal(quota([mail("old-pending", { status: "寄送中", gmailMessageId: null })]).shouldPause, true);
  });
  it("失敗、草稿與收到的回覆不消耗成功額度", () => {
    const records = [mail("failed", { status: "失敗", gmailMessageId: null }),
      mail("draft", { status: "未寄送", gmailMessageId: null }),
      mail("reply", { direction: "收到（人工補登）", kind: "回覆補登", status: "不適用（補登回覆）", gmailMessageId: null })];
    assert.equal(quota(records).sentToday, 0);
    assert.equal(quota(records).shouldPause, false);
  });
  it("無效現在時間、缺社團 ID、未知寄送狀態均不得放行", () => {
    assert.equal(quota([], "bad").shouldPause, true);
    assert.equal(quota([], now, "").shouldPause, true);
    const unknown = { ...mail("bad"), status: "未知" } as unknown as MailRecord;
    assert.equal(quota([unknown]).shouldPause, true);
  });
  it("失敗狀態卻有成功 Message ID 時不能當作可安全重寄", () => {
    const result = quota([mail("contradiction", { status: "失敗" })]);
    assert.equal(result.sentToday, 0);
    assert.equal(result.shouldPause, true);
    assert.ok(result.issues.some((i) => i.code === "invalid_record"));
  });
});

describe("純函式契約", () => {
  it("凍結輸入仍可運作；重複呼叫不修改輸入且結果一致", () => {
    const record = Object.freeze(mail("first"));
    const data = Object.freeze(followUp({
      mails: Object.freeze([record]), correspondences: Object.freeze([Object.freeze({ ...correspondence })]),
      scope: Object.freeze({ ...scope }), settings: Object.freeze({ ...settings }),
    }));
    const before = JSON.stringify(data);
    assert.deepEqual(evaluateFollowUp(data), evaluateFollowUp(data));
    assert.deepEqual(quota(data.mails), quota(data.mails));
    assert.equal(JSON.stringify(data), before);
  });
});
