const mongoose = require("mongoose");
const { asyncHandler } = require("../utils/asyncHandler");
const { sendResponse } = require("../utils/response");
const { sendRemindersToEligible } = require("../services/reminder.service");
const whatsappService = require("../services/whatsapp.service");
const Member = require("../models/member.model");
const { enforceBranchOwnership } = require("../middlewares/branchScope.middleware");
const dbg = require("../utils/whatsappDebug");

// Mirrors payment.controller's branch resolution so superadmin may target a
// selected branch and admins are always locked to their own branch. Never
// trusts req.body.branchCode supplied by the client.
const resolveRequestedBranch = (req) =>
  req.user.role === "superadmin"
    ? (req.query.branchCode && req.query.branchCode !== "ALL" && req.query.branchCode !== "all"
        ? req.query.branchCode.trim().toUpperCase()
        : undefined)
    : (req.user.branchCode || "MAIN").trim().toUpperCase();

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

// POST /api/payments/reminders
//
// Body (optional):
//   { memberIds: string[] }  -> individual reminders for the given members
//   {}                       -> bulk "send to all": backend computes the eligible
//                                members from the caller's branch scope only.
//
// The branch scope is ALWAYS derived from the authenticated user + query
// (superadmin), never from the request body. Cross-branch memberIds for an
// admin are rejected server-side.
const sendReminders = asyncHandler(async (req, res) => {
  dbg.log("reminder controller started (POST /api/payments/reminders)");
  const gymId = req.gymId;
  const branchCode = resolveRequestedBranch(req);
  dbg.log(
    `permission/branch check -> role=${req.user.role} effectiveBranch=${branchCode || "ALL"} (superadmin bypass; admin locked to own branch)`
  );

  let memberIds = [];
  if (req.body && req.body.memberIds !== undefined) {
    if (!Array.isArray(req.body.memberIds)) {
      dbg.error("memberIds validation", "expected an array");
      throw Object.assign(new Error("memberIds must be an array of member ids"), { statusCode: 400 });
    }
    memberIds = req.body.memberIds.map(String).filter(Boolean);
    dbg.log(`memberIds validation -> ${memberIds.length} requested member(s)`);
    if (memberIds.some((id) => !isValidObjectId(id))) {
      dbg.error("memberIds validation", "one or more ids are malformed");
      throw Object.assign(new Error("memberIds contains an invalid member id"), { statusCode: 400 });
    }
  }

  // Strict branch authorization (Phase 7): an Admin may send individual
  // reminders ONLY for members in their own branch. A memberId from another
  // branch (or missing) is rejected exactly like the existing member routes.
  if (memberIds.length > 0 && req.user.role !== "superadmin") {
    try {
      const scopedMembers = await Member.find({
        _id: { $in: memberIds },
        ...(gymId ? { gymId } : {})
      }).select("branchCode");
      const byId = new Map(scopedMembers.map((m) => [String(m._id), m]));
      for (const id of memberIds) {
        const member = byId.get(id);
        if (!member || !enforceBranchOwnership(member.branchCode, req)) {
          dbg.error("branch validation", `member ${id} is not in the admin's branch -> rejecting`);
          throw Object.assign(new Error("Member not found in your branch"), { statusCode: 404 });
        }
      }
      dbg.log("branch validation -> all requested members belong to the admin's branch");
    } catch (err) {
      if (err.statusCode) throw err;
      dbg.breakLog("cross-branch member lookup failed", err && err.message);
      throw err;
    }
  }

  dbg.log(
    `${memberIds.length > 0 ? "individual" : "bulk"} mode -> calling reminder.service sendRemindersToEligible (gymId=${
      gymId || "none"
    }, branch=${branchCode || "ALL"}, members=${memberIds.length || "auto"})`
  );
  let result;
  try {
    result = await sendRemindersToEligible({
      gymId,
      branchCode,
      memberIds,
      now: new Date()
    });
  } catch (err) {
    dbg.breakLog("reminder.service threw", err && err.message);
    throw err;
  }
  const { summary } = result;
  dbg.log(
    `reminder service returned -> eligible=${summary.eligible} inAppSent=${summary.inAppSent} whatsappSent=${summary.whatsappSent} whatsappFailed=${summary.whatsappFailed} whatsappInvalid=${summary.whatsappInvalid} whatsappNotConfigured=${summary.whatsappNotConfigured} whatsappSkipped=${summary.whatsappSkipped} status=${summary.whatsappStatus}`
  );

  const messages = [];
  if (summary.inAppSent > 0) messages.push(`${summary.inAppSent} in-app reminder(s) sent.`);
  if (summary.whatsappSent > 0) messages.push(`${summary.whatsappSent} WhatsApp message(s) sent.`);
  if (summary.whatsappFailed > 0) messages.push(`${summary.whatsappFailed} WhatsApp send(s) failed.`);
  if (summary.whatsappInvalid > 0) messages.push(`${summary.whatsappInvalid} skipped: invalid WhatsApp number.`);
  if (summary.whatsappNotConfigured > 0) {
    const cfg = whatsappService.getSafeConfig();
    const parts = [];
    if (!cfg.enabled) parts.push("WHATSAPP_ENABLED is not true");
    if (cfg.provider !== "meta") parts.push(`WHATSAPP_PROVIDER is "${cfg.provider || "not set"}" (expected "meta")`);
    if (!cfg.hasAccessToken) parts.push("WHATSAPP_ACCESS_TOKEN is missing");
    if (!cfg.hasPhoneNumberId) parts.push("WHATSAPP_PHONE_NUMBER_ID is missing");
    messages.push(`WhatsApp is not configured on the server (${parts.join("; ")}). Set these in server/.env and restart the server.`);
  }
  if (summary.whatsappDuplicate > 0) messages.push(`${summary.whatsappDuplicate} WhatsApp duplicate(s) skipped.`);
  if (summary.inAppDuplicateSkipped > 0) messages.push(`${summary.inAppDuplicateSkipped} in-app duplicate(s) skipped.`);

  // Per-member safe failure detail so the frontend can distinguish
  // invalid_token / template_not_found / template_not_approved /
  // invalid_phone_number / meta_api_error / failed without ever seeing the
  // access token. Only failures are listed; successes and duplicates are
  // covered by the summary counters.
  const whatsappErrors = (result.results || [])
    .filter((r) =>
      ["failed", "meta_api_error", "invalid_token", "template_not_found", "template_not_approved", "invalid_phone_number"].includes(r.whatsappStatus)
    )
    .map((r) => ({
      memberId: r.memberId,
      memberName: r.memberName || null,
      status: r.whatsappStatus,
      reason: r.whatsappReason || null,
      metaErrorCode: r.metaErrorCode ?? null,
      metaErrorSubcode: r.metaErrorSubcode ?? null,
      normalizedPhone: r.whatsappNumber ? dbg.maskPhone(r.whatsappNumber) : null
    }));

  dbg.log("reminder controller -> sending response");
  sendResponse(res, {
    status: 200,
    message: messages.length > 0 ? `Reminder processed. ${messages.join(" ")}` : "Reminder processed. No new reminders were needed.",
    data: { ...summary, whatsappStatus: summary.whatsappStatus, whatsappConfig: whatsappService.getSafeConfig(), whatsappErrors }
  });
});

module.exports = { sendReminders };