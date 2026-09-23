const Member = require("../models/member.model");
const Payment = require("../models/payment.model");
const Attendance = require("../models/attendance.model");
const User = require("../models/user.model");
const Plan = require("../models/plan.model");

const branchScope = async (req, _res, next) => {
  if (!req.user) return next();

  if (req.user.role === "superadmin") {
    // Superadmin can view all branches or filter by a specific branch
    if (req.query.branchCode && req.query.branchCode !== "ALL" && req.query.branchCode !== "all") {
      req.branchCode = req.query.branchCode.trim().toUpperCase();
      req.query.branchCode = req.branchCode;
    } else {
      req.branchCode = undefined;
      delete req.query.branchCode;
    }
    return next();
  }

  // For Admin / Trainer / Member: enforce assigned branchCode
  const branchCode = (req.user.branchCode || "MAIN").trim().toUpperCase();
  req.branchCode = branchCode;
  req.query.branchCode = branchCode;

  next();
};

/**
 * Validates that a target record belongs to the user's authorized branch.
 * Superadmin bypasses. Non-superadmin is restricted to their branchCode.
 */
const enforceBranchOwnership = (recordBranchCode, req) => {
  if (!req.user || req.user.role === "superadmin") return true;
  const userBranch = (req.user.branchCode || "MAIN").trim().toUpperCase();
  const targetBranch = (recordBranchCode || "MAIN").trim().toUpperCase();
  return userBranch === targetBranch;
};

module.exports = { branchScope, enforceBranchOwnership };