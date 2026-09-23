const Member = require("../models/member.model");
const Notification = require("../models/notification.model");
const { Branch } = require("../models/generic.model");
const whatsappService = require("./whatsapp.service");
const dbg = require("../utils/whatsappDebug");

/**
 * Number of calendar days (inclusive) of the renewal-reminder window:
 * TODAY, +1, ... +7 -> members whose plan expires within 7 calendar days.
 *
 * Business rule (Phase 5): a member is reminder-eligible when
 *    A) paymentStatus is "pending" (payment/membership pending), OR
 *    B) the CURRENT plan expires within REMINDER_WINDOW_DAYS calendar days.
 * Expired/cancelled/inactive/frozen memberships are excluded.
 */
const REMINDER_WINDOW_DAYS = (() => {
  const raw = Number(process.env.REMINDER_WINDOW_DAYS || 7);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 7;
})();

const DAY_MS = 1000 * 60 * 60 * 24;

const MAX_SENDS_PER_REQUEST = (() => {
  const raw = Number(process.env.WHATSAPP_MAX_SENDS_PER_REQUEST || 100);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 100;
})();

const CONCURRENCY = 3;

const startOfDay = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

const endOfDay = (date) => {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
};

const addDays = (date, days) => {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
};

/**
 * Return the calendar-day boundary range [startOfToday, endOfToday+7].
 * Uses server-local time consistently with the rest of the application.
 */
const getReminderWindow = (now = new Date()) => {
  const today = startOfDay(now);
  return { start: today, end: endOfDay(addDays(today, REMINDER_WINDOW_DAYS)) };
};

/**
 * Pure eligibility + window predicate used by every reminder pass so the DB
 * query and the per-member computation can never disagree.
 * See buildEligibilityFilter for the exact database twin of this logic.
 */
function computeEligibility(member, now = new Date()) {
  if (!member || typeof member !== "object") {
    return { eligible: false, reasons: null, daysRemaining: null, expiresAt: null };
  }
  const status = member.status;
  const paymentStatus = member.paymentStatus;
  const expiry = member.membershipExpiryDate ? new Date(member.membershipExpiryDate) : null;
  const statusOk = status === "active" || status === "pending";
  const reasons = [];

  // Rule A: pending payment/membership (same cohort the legacy cron notified).
  if (statusOk && paymentStatus === "pending") {
    reasons.push("pending_payment");
  }

  // Rule B: current plan expires within the rolling calendar window.
  // Already-expired dates (expiry < today) never match.
  if (status === "active" && member.currentPlan && expiry && !Number.isNaN(expiry.getTime())) {
    const { start: windowStart, end: windowEnd } = getReminderWindow(now);
    if (expiry >= windowStart && expiry <= windowEnd) {
      reasons.push("expiring_soon");
    }
  }

  const daysRemaining = expiry && !Number.isNaN(expiry.getTime()) ? computeDaysRemaining(expiry, now) : null;
  return {
    eligible: reasons.length > 0 && ![ "cancelled", "inactive", "frozen", "expired" ].includes(status),
    reasons: reasons.length > 0 ? reasons : null,
    daysRemaining,
    expiresAt: expiry && !Number.isNaN(expiry.getTime()) ? expiry.toISOString() : null
  };
}

/**
 * Calendar-day difference between two dates (inclusive of today).
 * expiry today -> 0, expiry in 7 days -> 7, expiry 8 days out -> 8.
 */
function computeDaysRemaining(expiryDate, now = new Date()) {
  const exp = startOfDay(new Date(expiryDate));
  const today = startOfDay(now);
  return Math.round((exp.getTime() - today.getTime()) / DAY_MS);
}

/**
 * Database twin of computeEligibility. Builds the Mongo filter for eligible
 * members. Optional objects are omitted so buildEligibilityFilter() is pure
 * and unit-testable without a database.
 */
function buildEligibilityFilter({ gymId, branchCode, now = new Date() } = {}) {
  const { start, end } = getReminderWindow(now);
  const filter = {
    status: { $in: ["active", "pending"] },
    $or: [
      // Rule A: pending payment/membership.
      { paymentStatus: "pending" },
      // Rule B: active membership expiring within the window.
      { status: "active", currentPlan: { $ne: null }, membershipExpiryDate: { $ne: null, $gte: start, $lte: end } }
    ]
  };
  if (gymId) filter.gymId = gymId;
  if (branchCode) filter.branchCode = branchCode;
  return filter;
}

/**
 * Find members who are reminder-eligible within the caller's branch scope.
 * Members have `user` and `currentPlan` populated (real database data).
 */
async function findEligibleMembers({ gymId, branchCode, now = new Date() }) {
  return Member.find(buildEligibilityFilter({ gymId, branchCode, now }))
    .populate("user", "name email phone")
    .populate("currentPlan", "name")
    .lean();
}

/**
 * Backward-compatible: active members whose CURRENT plan expires within the
 * reminder window (the legacy expiry-only query).
 */
async function findExpiringMembers({ gymId, branchCode, now = new Date() }) {
  const { start, end } = getReminderWindow(now);
  const filter = {
    status: "active",
    currentPlan: { $ne: null },
    membershipExpiryDate: { $ne: null, $gte: start, $lte: end }
  };
  if (gymId) filter.gymId = gymId;
  if (branchCode) filter.branchCode = branchCode;

  return Member.find(filter)
    .populate("user", "name email phone")
    .populate("currentPlan", "name")
    .lean();
}

/**
 * Is there already an expiry reminder recorded for this member on the given
 * reminder calendar day? Identity: member + expiryDate + reminderDate + type.
 */
async function hasReminderBeenSent(member, reminderDate, expiryDate) {
  const dayStart = startOfDay(reminderDate);
  const dayEnd = endOfDay(reminderDate);
  return Notification.exists({
    member: member._id || member,
    type: "expiry",
    reminderDate: { $gte: dayStart, $lte: dayEnd },
    expiryDate: expiryDate
  });
}

/**
 * Create an in-app expiry reminder notification for a member.
 */
async function createInAppReminder(member, reminderDate) {
  const user = member.user;
  const memberName = (user && user.name) ? user.name : "there";
  const expiryLabel = member.membershipExpiryDate
    ? new Date(member.membershipExpiryDate).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
    : "";

  const notification = await Notification.create({
    user: user && user._id ? user._id : member.user,
    member: member._id,
    plan: member.currentPlan && member.currentPlan._id ? member.currentPlan._id : (member.currentPlan || null),
    expiryDate: member.membershipExpiryDate,
    reminderDate: reminderDate,
    type: "expiry",
    channel: "inApp",
    title: "Membership Expiring Soon",
    message: `Hi ${memberName}, your membership expires on ${expiryLabel}. Please renew your membership to continue your fitness journey.`
  });
  return notification;
}

const formatDate = (date) =>
  date
    ? new Date(date).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
    : "";

/**
 * Is there already a WhatsApp expiry reminder recorded for this member on the
 * given reminder calendar day? Identity: member + expiryDate + reminderDate +
 * type + channel="whatsapp". Only successfully delivered sends are stored, so
 * a failed/skipped attempt never blocks a retry.
 */
async function hasWhatsappReminderBeenSent(member, reminderDate, expiryDate) {
  const dayStart = startOfDay(reminderDate);
  const dayEnd = endOfDay(reminderDate);
  return Notification.exists({
    member: member._id || member,
    type: "expiry",
    channel: "whatsapp",
    reminderDate: { $gte: dayStart, $lte: dayEnd },
    expiryDate: expiryDate
  });
}

/**
 * Persist a WhatsApp expiry reminder. Called ONLY after Meta returned a message
 * id for this request - a failed deliverable is never recorded as sent.
 */
async function createWhatsappReminder(member, reminderDate, metaMessageId) {
  const user = member.user;
  const memberName = (user && user.name) ? user.name : "there";
  const expiryLabel = member.membershipExpiryDate
    ? new Date(member.membershipExpiryDate).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
    : "";

  const notification = await Notification.create({
    user: user && user._id ? user._id : member.user,
    member: member._id,
    plan: member.currentPlan && member.currentPlan._id ? member.currentPlan._id : (member.currentPlan || null),
    expiryDate: member.membershipExpiryDate,
    reminderDate: reminderDate,
    type: "expiry",
    channel: "whatsapp",
    provider: "meta",
    metaMessageId: metaMessageId || null,
    title: "Membership Expiring Soon (WhatsApp)",
    message: `WhatsApp expiry reminder sent to ${memberName} about membership expiring on ${expiryLabel}.`
  });
  return notification;
}

/**
 * Resolve the display name for a branch code (used as template variable {{2}}).
 * Falls back to the branch code when the branch entity is not found.
 */
const branchNameCache = new Map();
async function resolveBranchName(gymId, branchCode) {
  const key = `${gymId || ""}:${branchCode || ""}`;
  if (branchNameCache.has(key)) return branchNameCache.get(key);
  let name = branchCode;
  try {
    const branch = await Branch.findOne({
      ...(gymId ? { gymId } : {}),
      branchCode: (branchCode || "MAIN").toUpperCase()
    })
      .select("name")
      .lean();
    if (branch && branch.name) name = branch.name;
  } catch {
    // Branch lookup is best-effort; fall back to the code.
  }
  branchNameCache.set(key, name);
  return name;
}

/**
 * Build the ordered Meta template parameters {{1..6}} for a member.
 * Every value is derived from the database record (never from the client).
 */
function buildTemplateParameters(member, branchName, now = new Date()) {
  const user = member.user || {};
  const plan = member.currentPlan || {};
  return [
    user.name || "Member",
    branchName || (member.branchCode || "MAIN").toUpperCase(),
    plan.name || "Membership",
    formatDate(member.membershipStartDate),
    formatDate(member.membershipExpiryDate),
    String(computeDaysRemaining(new Date(member.membershipExpiryDate), now))
  ];
}

/**
 * Run the in-app + WhatsApp reminder for ONE eligible member and return the
 * per-member result object. Never claims a WhatsApp delivery that did not
 * happen; never trusts data supplied by the client.
 */
async function sendReminderForMember(member, {
  reminderDate,
  now = new Date(),
  hasSent = hasReminderBeenSent,
  createNotif = createInAppReminder,
  branchNameResolver = resolveBranchName,
  whatsappSender = whatsappService,
  hasWhatsappSent = hasWhatsappReminderBeenSent,
  createWhatsappNotif = createWhatsappReminder
} = {}) {
  const user = member.user || {};
  const rawPhone = user.phone ? String(user.phone).trim() : "";
  const normalizedPhone = rawPhone ? whatsappSender.normalizePhoneNumber(rawPhone) : null;
  const eligibility = computeEligibility(member, now);

  dbg.log(
    `member ${member._id} (${user.name || "unknown"}) -> eligibility check: status=${member.status} paymentStatus=${
      member.paymentStatus
    } phone=${rawPhone ? dbg.maskPhone(rawPhone) : "none"}`
  );

  const result = {
    memberId: member._id,
    memberName: user.name || "Member",
    whatsappNumber: normalizedPhone || (rawPhone || null),
    branchCode: (member.branchCode || "MAIN").toUpperCase(),
    planName: (member.currentPlan && member.currentPlan.name) || null,
    membershipStartDate: member.membershipStartDate ? new Date(member.membershipStartDate).toISOString() : null,
    membershipExpiryDate: member.membershipExpiryDate ? new Date(member.membershipExpiryDate).toISOString() : null,
    daysRemaining: eligibility.daysRemaining,
    eligibilityReasons: eligibility.reasons,
    inAppNotification: "skipped",
    whatsappStatus: "skipped",
    whatsappReason: null
  };

  if (!eligibility.eligible) {
    result.whatsappStatus = "skipped";
    result.whatsappReason = "not_eligible";
    dbg.log(`member ${member._id} -> NOT eligible (${eligibility.reasons ? eligibility.reasons.join(",") : "no reason"})`);
    return result;
  }
  dbg.log(`member ${member._id} -> eligible: ${eligibility.reasons.join(",")} (daysRemaining=${eligibility.daysRemaining})`);

  // ── In-app expiry notification (existing behaviour, expiry cohort only) ──
  if (eligibility.reasons && eligibility.reasons.includes("expiring_soon")) {
    const alreadySent = await hasSent(member, reminderDate, member.membershipExpiryDate);
    if (alreadySent) {
      result.inAppNotification = "duplicate_skipped";
    } else {
      await createNotif(member, reminderDate);
      result.inAppNotification = "created";
    }
  }

  // ── WhatsApp delivery through the Meta Cloud API service ──
  if (!rawPhone) {
    result.whatsappStatus = "skipped";
    result.whatsappReason = "no_phone_on_record";
    dbg.error(`member ${member._id} -> whatsapp skipped: no phone number on record`);
    return result;
  }
  if (!normalizedPhone) {
    result.whatsappStatus = "invalid_phone_number";
    result.whatsappReason = "phone number could not be normalized to E.164";
    dbg.error(`member ${member._id} -> whatsapp invalid_phone_number: raw number (${dbg.maskPhone(rawPhone)}) could not be normalized`);
    return result;
  }
  dbg.log(`member ${member._id} -> phone validated: E.164 ${dbg.maskPhone(normalizedPhone)} (country code + local)`);

  // The reminder template needs plan/start/expiry/days. A pending member with
  // no term yet cannot fill those placeholders -> skip instead of faking.
  if (!member.membershipExpiryDate || !member.membershipStartDate) {
    result.whatsappStatus = "skipped";
    result.whatsappReason = "no_membership_dates";
    dbg.error(`member ${member._id} -> whatsapp skipped: no membership dates to fill the template`);
    return result;
  }

  // Already-expired term (status still flips via the hourly cron): never
  // message someone whose membership has actually lapsed.
  const daysRemaining = computeDaysRemaining(member.membershipExpiryDate, now);
  if (daysRemaining < 0) {
    result.whatsappStatus = "skipped";
    result.whatsappReason = "membership_expired";
    dbg.error(`member ${member._id} -> whatsapp skipped: membership already expired (${daysRemaining} days ago)`);
    return result;
  }

  // WhatsApp duplicate protection: a NEW message is sent only when no previous
  // WhatsApp reminder was recorded for this member on this calendar day/expiry.
  // In-app notifications and in-app duplicates never block a WhatsApp send, and
  // a failed WhatsApp attempt is never persisted, so it can never count as one.
  if (await hasWhatsappSent(member, reminderDate, member.membershipExpiryDate)) {
    result.whatsappStatus = "duplicate";
    result.whatsappReason = "alreadysent_on_reminder_date";
    dbg.log(`member ${member._id} -> whatsapp duplicate: already sent for this reminder date (no new request sent to Meta)`);
    return result;
  }

  const branchName = await branchNameResolver(member.gymId, result.branchCode);
  const parameters = buildTemplateParameters(member, branchName, now);
  dbg.log(`member ${member._id} -> building template parameters (${parameters.length} placeholders) for template ${whatsappSender.getTemplateName()}`);

  dbg.log(`member ${member._id} -> calling whatsapp.service (to=${dbg.maskPhone(normalizedPhone)})`);
  const sendResult = await whatsappSender.sendTemplateMessage({
    to: normalizedPhone,
    parameters
  });

  result.whatsappStatus = sendResult.status;
  result.whatsappReason = sendResult.reason || sendResult.error || null;
  if (sendResult.metaMessageId) result.metaMessageId = sendResult.metaMessageId;
  if (sendResult.metaErrorCode !== undefined && sendResult.metaErrorCode !== null) {
    result.metaErrorCode = sendResult.metaErrorCode;
  }
  if (sendResult.metaErrorSubcode !== undefined && sendResult.metaErrorSubcode !== null) {
    result.metaErrorSubcode = sendResult.metaErrorSubcode;
  }

  if (sendResult.status === "sent") {
    // Persist ONLY a confirmed delivery: Meta returned a message id for this
    // request. Failed or skipped attempts are not recorded as sent.
    try {
      await createWhatsappNotif(member, reminderDate, sendResult.metaMessageId);
    } catch (persistErr) {
      dbg.breakLog(`member ${member._id} -> Meta accepted the message (${sendResult.metaMessageId}) but the reminder record could not be saved`, persistErr && persistErr.message);
    }
    dbg.log(`member ${member._id} -> whatsapp send COMPLETED (metaMessageId=${sendResult.metaMessageId})`);
  } else if (sendResult.status === "not_configured") {
    dbg.log(`member ${member._id} -> whatsapp not_configured (no Meta credentials) - skipped, no delivery attempted`);
  } else if (sendResult.status === "duplicate") {
    dbg.log(`member ${member._id} -> whatsapp duplicate recorded for this reminder date`);
  } else {
    dbg.error(`member ${member._id} -> whatsapp send FAILED (status=${sendResult.status}, reason=${sendResult.reason})`);
  }
  return result;
}

/**
 * Process a list of members with limited concurrency (avoid overwhelming the
 * Meta API on bulk requests).
 */
async function runWithConcurrency(items, worker, limit = CONCURRENCY) {
  const results = [];
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      try {
        results[current] = await worker(items[current]);
      } catch (err) {
        dbg.breakLog(`per-member worker failed (member ${items[current] && items[current]._id})`, err && err.message);
        throw err;
      }
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Core reminder pass.
 *
 * @param {object} opts
 * @param {string} opts.gymId
 * @param {string} [opts.branchCode] - Effective branch scope (undefined = all/superadmin).
 * @param {string[]} [opts.memberIds] - Individual-reminder mode: only these members.
 * @param {Date} [opts.now]
 * @returns {Promise<{summary: object, results: Array}>}
 */
async function sendRemindersToEligible({ gymId, branchCode, memberIds, now = new Date() } = {}) {
  const reminderDate = startOfDay(now);
  dbg.logConfig(whatsappService.getSafeConfig());
  dbg.log(`reminder.service entered: gymId=${gymId || "none"} branch=${branchCode || "ALL"} mode=${Array.isArray(memberIds) && memberIds.length ? "individual" : "bulk"} window=${REMINDER_WINDOW_DAYS}d`);
  const summary = {
    eligible: 0,
    requested: 0,
    inAppSent: 0,
    inAppDuplicateSkipped: 0,
    inAppSkipped: 0,
    duplicatesSkipped: 0,
    whatsappSent: 0,
    whatsappFailed: 0,
    whatsappInvalid: 0,
    whatsappNotConfigured: 0,
    whatsappDuplicate: 0,
    whatsappSkipped: 0,
    whatsappReady: 0,
    whatsappStatus: "not_configured",
    truncated: false,
    results: []
  };

  let members;
  const requestedMemberIds = Array.isArray(memberIds) ? memberIds.map(String).filter(Boolean) : [];

  if (requestedMemberIds.length > 0) {
    // Individual mode: fetch EXACTLY the requested ids within scope. Any id that
    // is missing or outside the effective branch scope resolves to a skipped
    // result below (the controller additionally rejects cross-branch admin ids).
    const filter = { _id: { $in: requestedMemberIds } };
    if (gymId) filter.gymId = gymId;
    if (branchCode) filter.branchCode = branchCode;
    members = await Member.find(filter)
      .populate("user", "name email phone")
      .populate("currentPlan", "name")
      .lean();
    summary.requested = requestedMemberIds.length;
    dbg.log(`member lookup (individual) -> found ${members.length} of ${requestedMemberIds.length} requested member(s) in scope`);
  } else {
    // Bulk ("send to all"): the backend decides the recipients from branch scope
    // and eligibility alone - the client-supplied list is never trusted to
    // determine the recipients.
    members = await findEligibleMembers({ gymId, branchCode, now });
    summary.requested = members.length;
    dbg.log(`member lookup (bulk, eligibility-filtered) -> ${members.length} eligible member(s)`);
  }

  const inScopeIds = new Set(members.map((m) => String(m._id)));
  const missingResults = requestedMemberIds
    .filter((id) => !inScopeIds.has(id))
    .map((id) => ({
      memberId: id,
      memberName: null,
      whatsappNumber: null,
      branchCode: branchCode || null,
      planName: null,
      membershipStartDate: null,
      membershipExpiryDate: null,
      daysRemaining: null,
      eligibilityReasons: null,
      inAppNotification: "skipped",
      whatsappStatus: "skipped",
      whatsappReason: "member_not_found_or_not_in_scope"
    }));

  const target = members.slice(0, MAX_SENDS_PER_REQUEST);
  if (members.length > MAX_SENDS_PER_REQUEST) summary.truncated = true;

  const perMemberResults = await runWithConcurrency(
    target,
    (member) => sendReminderForMember(member, { reminderDate, now }),
    CONCURRENCY
  );

  const results = [...perMemberResults, ...missingResults];
  summary.results = results;

  for (const r of results) {
    if (r.eligibilityReasons) summary.eligible += 1;
    if (r.inAppNotification === "created") summary.inAppSent += 1;
    if (r.inAppNotification === "duplicate_skipped") summary.inAppDuplicateSkipped += 1;
    const was = r.whatsappStatus;
    if (was === "sent") {
      summary.whatsappSent += 1;
      summary.whatsappReady += 1;
    } else if (was === "failed" || was === "meta_api_error" || was === "invalid_token" || was === "template_not_found" || was === "template_not_approved") {
      summary.whatsappFailed += 1;
    } else if (was === "invalid_phone_number") {
      summary.whatsappInvalid += 1;
    } else if (was === "not_configured") {
      summary.whatsappNotConfigured += 1;
      summary.whatsappSkipped += 1;
    } else if (was === "duplicate") {
      summary.whatsappDuplicate += 1;
      summary.whatsappSkipped += 1;
    } else {
      summary.whatsappSkipped += 1;
    }
  }
  summary.duplicatesSkipped = summary.inAppDuplicateSkipped + summary.whatsappDuplicate;

  summary.whatsappStatus = summary.whatsappSent > 0
    ? "sent"
    : whatsappService.isConfigured()
      ? (summary.whatsappFailed > 0 ? "failed" : summary.whatsappDuplicate > 0 ? "duplicate" : "configured")
      : "not_configured";

  dbg.log(
    `reminder.service completed -> eligible=${summary.eligible} inAppSent=${summary.inAppSent} whatsappSent=${summary.whatsappSent} whatsappFailed=${summary.whatsappFailed} whatsappInvalid=${summary.whatsappInvalid} whatsappDuplicate=${summary.whatsappDuplicate} whatsappNotConfigured=${summary.whatsappNotConfigured} whatsappSkipped=${summary.whatsappSkipped} whatsappStatus=${summary.whatsappStatus}${summary.truncated ? " (TRUNCATED)" : ""}`
  );

  return { summary, results };
}

/**
 * Backward-compatible aggregate pass (used by the expiry cron job). Keeps the
 * old summary shape and the old in-app expiry behaviour; now also covers the
 * 7-day window and pending-payment members for WhatsApp.
 */
async function sendRenewalReminders({ gymId, branchCode, now = new Date() } = {}) {
  dbg.log("sendRenewalReminders entered (cron/legacy entry point)-> forwarding to sendRemindersToEligible");
  const { summary } = await sendRemindersToEligible({ gymId, branchCode, now });

  const legacySummary = {
    eligible: summary.eligible,
    inAppSent: summary.inAppSent,
    whatsappReady: summary.whatsappReady,
    whatsappSkipped: summary.whatsappSkipped,
    duplicatesSkipped: summary.duplicatesSkipped,
    whatsappStatus: summary.whatsappStatus
  };
  dbg.log(`sendRenewalReminders completed -> legacy summary whatsappStatus=${legacySummary.whatsappStatus}`);
  return legacySummary;
}

module.exports = {
  REMINDER_WINDOW_DAYS,
  startOfDay,
  endOfDay,
  addDays,
  getReminderWindow,
  computeEligibility,
  computeDaysRemaining,
  buildEligibilityFilter,
  findEligibleMembers,
  findExpiringMembers,
  hasReminderBeenSent,
  hasWhatsappReminderBeenSent,
  createInAppReminder,
  createWhatsappReminder,
  buildTemplateParameters,
  sendReminderForMember,
  sendRemindersToEligible,
  sendRenewalReminders,
  runWithConcurrency
};