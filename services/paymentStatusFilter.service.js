const Member = require("../models/member.model");
const { getReminderWindow, startOfDay, addDays } = require("./reminder.service");

// Business windows for the /payments Status dropdown.
// PAID    ~15-20 days : "members who recently purchased or renewed a plan"
// PENDING ~30-40 days : "members who have not purchased/renewed a plan recently"
const PAID_WINDOW_DAYS = 20;
const PAID_MIN_DAYS = 15;
const PENDING_WINDOW_DAYS = 30;

const BUCKET_PAID = "paid";
const BUCKET_EXPIRING = "expiring";
const BUCKET_PENDING = "pending";

/**
 * Resolve the set of member ids that belong to a business-status bucket for the
 * /payments Status dropdown.
 *
 * Source of truth (audited against the existing data model):
 *  - The "latest plan purchase/renewal date" is `Member.membershipStartDate`
 *    (always set/updated on assignPlan, renewPlan, upgradePlan). It is the
 *    canonical membership-term start used by invoices, so it correctly
 *    represents "when the member purchased/renewed their current plan".
 *  - Expiring Soon uses `Member.membershipExpiryDate` with the exact same
 *    calendar-day logic as reminder.service.js.
 *
 * Branch isolation: when `branchCode` is provided the members are scoped to
 * that branch. Callers are expected to pass the authoritative branch
 * (admin -> own branch; superadmin -> selected branch or ALL/undefined).
 *
 * @param {object} opts
 * @param {string} opts.gymId
 * @param {string} [opts.branchCode] - Branch to scope to (omit for all).
 * @param {string} opts.code  - "paid" | "expiring" | "pending"
 * @param {Date}   [opts.now] - Overridable reference time (testing / jobs).
 * @returns {Promise<Array>} Distinct member _ids.
 */
async function resolveBusinessStatusMemberIds({ gymId, branchCode, code, now = new Date() }) {
  const today = startOfDay(now);
  const filter = { gymId };
  if (branchCode) filter.branchCode = branchCode.toString().toUpperCase();

  if (code === BUCKET_PAID) {
    // Recently purchased/renewed 15-20 calendar days ago AND has a current plan.
    // The lower bound (>= today-20) and upper bound (<= today-15) keep Paid a
    // distinct category from Expiring Soon: recent buyers (0-14 days, incl. today)
    // are NOT "Paid", so today's / this-week purchasers never leak into Paid.
    filter.currentPlan = { $ne: null };
    filter.membershipStartDate = {
      $gte: addDays(today, -PAID_WINDOW_DAYS),
      $lte: addDays(today, -PAID_MIN_DAYS)
    };
  } else if (code === BUCKET_EXPIRING) {
    // Same calendar-day eligibility as the Send Reminders feature
    // (today .. today+3), preserving the frozen/expired exclusion rules.
    const { start, end } = getReminderWindow(now);
    filter.status = "active";
    filter.currentPlan = { $ne: null };
    filter.membershipExpiryDate = { $ne: null, $gte: start, $lte: end };
  } else if (code === BUCKET_PENDING) {
    // Latest renewal is 30+ days old -> "not purchased/renewed recently".
    filter.membershipStartDate = { $lte: addDays(today, -PENDING_WINDOW_DAYS) };
  } else {
    return [];
  }

  return Member.find(filter).distinct("_id");
}

module.exports = {
  resolveBusinessStatusMemberIds,
  PAID_WINDOW_DAYS,
  PAID_MIN_DAYS,
  PENDING_WINDOW_DAYS,
  BUCKET_PAID,
  BUCKET_EXPIRING,
  BUCKET_PENDING
};
