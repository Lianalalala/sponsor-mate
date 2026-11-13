import { countSuccessfulSends, daysSinceLastSuccessfulSend, inspectScope } from "./history.ts";
import type { FollowUpInput, HistoryInput, RuleReason } from "./types.ts";

export function classifyInvitation(input: HistoryInput) {
  const history = countSuccessfulSends(input);
  const classification = history.issues.length > 0 || history.unresolvedCount > 0 ? "needs_review" :
    history.successCount === 0 ? "initial_invitation" : "subsequent_contact";
  return { classification, history } as const;
}

/** 只是催信候選建議，絕不代表已核准或已通過完整寄前檢核。 */
export function evaluateFollowUp(input: FollowUpInput) {
  const history = daysSinceLastSuccessfulSend(input);
  const { correspondence } = inspectScope(input);
  const reasons: RuleReason[] = [];
  if (history.issues.length > 0) reasons.push({ code: "data_review", message: "寄件資料或時間需要核對，暫不建議催信。" });
  if (history.unresolvedCount > 0) reasons.push({ code: "unresolved_send", message: "有寄送中或結果待確認的郵件，請先核對，不能直接重寄。" });
  const { intervalDays, maxFollowUps } = input.settings;
  const validSettings = Number.isSafeInteger(intervalDays) && intervalDays >= 1 &&
    Number.isSafeInteger(maxFollowUps) && maxFollowUps >= 0;
  if (!validSettings) reasons.push({ code: "invalid_settings", message: "追蹤間隔須為正整數，催信上限須為非負整數。" });
  if (input.vendorStopContact === true) reasons.push({ code: "stop_contact", message: "廠商要求停止聯絡，所有活動都不能繼續催信。" });
  else if (input.vendorStopContact !== false) reasons.push({ code: "data_review", message: "尚未確認廠商是否要求停止聯絡。" });
  if (correspondence?.processingDecision === "stop") {
    reasons.push({ code: "stop_follow_up", message: "此活動的處理決策是停止追蹤。" });
  } else if (correspondence?.processingDecision !== "continue") {
    reasons.push({ code: "decision_review", message: "處理決策尚未明確允許繼續追蹤。" });
  }
  if (input.hasUnhandledReply === true || correspondence?.contactStatus === "已回覆・待處理") {
    reasons.push({ code: "pending_reply", message: "有尚未處理的回覆，請先處理回覆。" });
  } else if (input.hasUnhandledReply !== false) {
    reasons.push({ code: "data_review", message: "尚未確認有無待處理回覆。" });
  }
  if (correspondence?.contactStatus === "已拒絕") reasons.push({ code: "rejected", message: "廠商已拒絕此活動，不建議催信。" });
  else if (["未聯絡", "已回覆・待處理", "洽談中", "已同意合作"].includes(correspondence?.contactStatus ?? "")) {
    reasons.push({ code: "not_awaiting_reply", message: "目前不是單純等待邀約回覆的狀態。" });
  } else if (correspondence?.contactStatus !== "已寄出・尚未回覆") {
    reasons.push({ code: "contact_review", message: "聯絡狀態不明，請先確認。" });
  }
  if (history.successCount === 0) reasons.push({ code: "no_successful_send", message: "沒有成功外寄紀錄，應先確認初次邀約，不能算催信。" });
  if (validSettings && history.followUpCount >= maxFollowUps) {
    reasons.push({ code: "follow_up_limit", message: `已達成功催信 ${maxFollowUps} 次上限（不含首次邀約）。` });
  }
  if (validSettings && history.daysSince !== null && history.daysSince < intervalDays) {
    reasons.push({ code: "interval_not_met", message: `距上次成功寄信 ${history.daysSince} 天，尚未達 ${intervalDays} 天間隔。` });
  }
  const recommended = reasons.length === 0 && history.daysSince !== null;
  if (recommended) reasons.push({ code: "follow_up_suggested", message: "已達追蹤間隔且未達催信上限，可列為催信候選，仍須人工逐封核准。" });
  return { recommended, reasons, history };
}
