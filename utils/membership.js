const { AppError } = require("./appError");

const BLOCKED_MEMBER_STATUSES = ["inactive", "pending", "cancelled", "expired"];

const BLOCKED_BY_ATTENDANCE_STATUSES = ["inactive", "pending", "cancelled", "expired", "frozen"];

function getEligibilityIssue(member) {
  if (!member) return "unknown_user";
  if (BLOCKED_BY_ATTENDANCE_STATUSES.includes(member.status)) return "ineligible";
  const now = new Date();
  const isExpired = member.membershipExpiryDate && now > new Date(member.membershipExpiryDate);
  if (isExpired) return "expired";
  if (member.paymentStatus && member.paymentStatus !== "paid") return "payment_pending";
  return null;
}

function assertMemberEligible(member) {
  const issue = getEligibilityIssue(member);
  if (issue === "unknown_user") throw new AppError("Member profile not found", 404);
  if (issue === "ineligible") throw new AppError(`Account ${member.status}. Please contact admin.`, 403);
  if (issue === "expired") throw new AppError("Membership expired. Please renew your membership to continue.", 403);
  if (issue === "payment_pending") throw new AppError("Payment pending. Please complete your payment to continue.", 403);
}

module.exports = { assertMemberEligible, getEligibilityIssue, BLOCKED_MEMBER_STATUSES, BLOCKED_BY_ATTENDANCE_STATUSES };