const Plan = require("../models/plan.model");
const { AppError } = require("./appError");
const { formatDateInTimezone, DEFAULT_TIMEZONE } = require("./date");

const BLOCKED_MEMBER_STATUSES = ["inactive", "pending", "cancelled", "expired"];

const BLOCKED_BY_ATTENDANCE_STATUSES = ["inactive", "pending", "cancelled", "expired", "frozen"];

const ATTENDANCE_ELIGIBILITY_REASONS = [
  "unknown_user",
  "no_plan",
  "plan_invalid",
  "not_started",
  "expired",
  "payment_pending",
  "ineligible",
  "branch_mismatch",
  "invalid_timestamp"
];

const isValidDate = (value) => value instanceof Date && !Number.isNaN(value.getTime());

function toValidDate(value) {
  if (value === undefined || value === null || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return isValidDate(date) ? date : null;
}

function normalizeBranch(value) {
  return String(value || "").trim().toUpperCase();
}

function planMatchesBranch(plan, member) {
  const planBranch = normalizeBranch(plan.branchCode);
  if (!planBranch || planBranch === "ALL") return true;
  return planBranch === normalizeBranch(member.branchCode || "MAIN");
}

async function resolvePlan(member) {
  const ref = member.currentPlan;
  if (!ref) return null;

  // Always load the plan inside the member's gym. Besides tenant isolation this
  // deliberately re-checks the database even for a populated plan, so a stale
  // or deleted plan reference can never be treated as valid. Note that a
  // Mongoose ObjectId also exposes `_id` (itself), so checking `ref._id` alone
  // would incorrectly mistake an id for a populated plan.
  const planId = ref && typeof ref === "object" && ref._id ? ref._id : ref;
  return Plan.findOne({ _id: planId, gymId: member.gymId });
}

function getCalendarDate(value, timezone) {
  const date = toValidDate(value);
  return date ? formatDateInTimezone(date, timezone) : null;
}

function isMembershipTermActiveAt(startDate, expiryDate, atDate = new Date(), timezone = DEFAULT_TIMEZONE) {
  const start = getCalendarDate(startDate, timezone);
  const expiry = getCalendarDate(expiryDate, timezone);
  const at = getCalendarDate(atDate, timezone);
  if (!start || !expiry || !at) return false;
  return start <= at && at <= expiry;
}

function isMembershipTermStartedAt(startDate, atDate = new Date(), timezone = DEFAULT_TIMEZONE) {
  const start = getCalendarDate(startDate, timezone);
  const at = getCalendarDate(atDate, timezone);
  if (!start || !at) return false;
  return start <= at;
}

function isMembershipTermExpiredAt(expiryDate, atDate = new Date(), timezone = DEFAULT_TIMEZONE) {
  const expiry = getCalendarDate(expiryDate, timezone);
  const at = getCalendarDate(atDate, timezone);
  if (!expiry || !at) return true;
  return at > expiry;
}

// A paid payment cannot create eligibility on its own: an existing plan and a
// started, unexpired calendar term must already be present.
async function canActivateMembership(member, gymId, at = new Date(), timezone = DEFAULT_TIMEZONE) {
  if (!member || !member.currentPlan || !member.membershipStartDate || !member.membershipExpiryDate) return false;
  if (gymId && member.gymId && String(member.gymId) !== String(gymId)) return false;
  const plan = await resolvePlan(member);
  if (!plan || !plan._id) return false;
  if (gymId && plan.gymId && String(plan.gymId) !== String(gymId)) return false;
  return isMembershipTermActiveAt(member.membershipStartDate, member.membershipExpiryDate, at, timezone);
}

/**
 * Authoritative attendance eligibility rule.
 *
 * Membership dates are calendar dates in the gym/device timezone. The expiry
 * date is inclusive: a member remains eligible for the whole expiry day and
 * becomes expired on the following calendar day.
 */
async function getMembershipEligibility(member, atDate = new Date(), options = {}) {
  const timezone = options.timezone || DEFAULT_TIMEZONE;
  const at = toValidDate(atDate);
  if (!at) return { eligible: false, reason: "invalid_timestamp" };
  if (!member) return { eligible: false, reason: "unknown_user" };

  if (BLOCKED_BY_ATTENDANCE_STATUSES.includes(member.status)) {
    return { eligible: false, reason: "ineligible" };
  }

  if (member.paymentStatus !== "paid") {
    return { eligible: false, reason: "payment_pending" };
  }

  if (!member.currentPlan) {
    return { eligible: false, reason: "no_plan" };
  }

  const plan = await resolvePlan(member);
  if (!plan || !plan._id) {
    return { eligible: false, reason: "plan_invalid" };
  }
  if (plan.gymId && String(plan.gymId) !== String(member.gymId)) {
    return { eligible: false, reason: "plan_invalid" };
  }
  if (!planMatchesBranch(plan, member)) {
    return { eligible: false, reason: "plan_invalid" };
  }

  if (member.isActivePlan !== true) {
    return { eligible: false, reason: "plan_invalid" };
  }

  const startDate = toValidDate(member.membershipStartDate);
  const expiryDate = toValidDate(member.membershipExpiryDate);
  if (!startDate || !expiryDate) {
    return { eligible: false, reason: "plan_invalid" };
  }

  const attendanceDay = getCalendarDate(at, timezone);
  const startDay = getCalendarDate(startDate, timezone);
  const expiryDay = getCalendarDate(expiryDate, timezone);

  if (attendanceDay < startDay) {
    return { eligible: false, reason: "not_started" };
  }
  if (attendanceDay > expiryDay) {
    return { eligible: false, reason: "expired" };
  }

  return {
    eligible: true,
    reason: null,
    plan,
    attendanceDate: attendanceDay,
    membershipStartDate: startDay,
    membershipExpiryDate: expiryDay
  };
}

async function getEligibilityIssue(member, atDate = new Date(), options = {}) {
  const result = await getMembershipEligibility(member, atDate, options);
  return result.eligible ? null : result.reason;
}

function eligibilityErrorMessage(issue, member) {
  switch (issue) {
    case "unknown_user":
      return { message: "Member profile not found", status: 404 };
    case "no_plan":
      return { message: "No membership plan is assigned. Please choose a plan to continue.", status: 403 };
    case "plan_invalid":
      return { message: "Membership plan is invalid. Please contact admin.", status: 403 };
    case "not_started":
      return { message: "Membership has not started yet. Please contact admin.", status: 403 };
    case "expired":
      return { message: "Membership expired. Please renew your membership to continue.", status: 403 };
    case "payment_pending":
      return { message: "Payment pending. Please complete your payment to continue.", status: 403 };
    case "invalid_timestamp":
      return { message: "Invalid attendance timestamp", status: 400 };
    case "ineligible":
    default:
      return { message: `Account ${member && member.status ? member.status : "ineligible"}. Please contact admin.`, status: 403 };
  }
}

async function assertMemberEligible(member, atDate = new Date(), options = {}) {
  const issue = await getEligibilityIssue(member, atDate, options);
  if (!issue) return null;
  const error = eligibilityErrorMessage(issue, member);
  throw new AppError(error.message, error.status);
}

module.exports = {
  assertMemberEligible,
  canActivateMembership,
  getEligibilityIssue,
  getMembershipEligibility,
  isMembershipTermActiveAt,
  isMembershipTermStartedAt,
  isMembershipTermExpiredAt,
  resolvePlan,
  ATTENDANCE_ELIGIBILITY_REASONS,
  BLOCKED_MEMBER_STATUSES,
  BLOCKED_BY_ATTENDANCE_STATUSES
};
