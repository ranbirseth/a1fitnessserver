const mongoose = require("mongoose");
const { Branch } = require("../models/generic.model");
const Member = require("../models/member.model");
const User = require("../models/user.model");
const Payment = require("../models/payment.model");
const Attendance = require("../models/attendance.model");
const { asyncHandler } = require("../utils/asyncHandler");
const { sendResponse } = require("../utils/response");
const { getPagination } = require("../utils/pagination");
const { renameBranchCode } = require("../services/branchRename.service");

const branchFilter = req => {
  const filter = { gymId: req.gymId };
  if (req.user && req.user.role !== "superadmin") {
    filter.branchCode = (req.user.branchCode || "MAIN").trim().toUpperCase();
  } else if (req.query.branchCode && req.query.branchCode !== "ALL" && req.query.branchCode !== "all") {
    filter.branchCode = req.query.branchCode.trim().toUpperCase();
  }
  return filter;
};

const listBranches = asyncHandler(async (req, res) => {
  const { skip, limit, page } = getPagination(req.query);
  const query = branchFilter(req);
  if (req.query.search) query.name = new RegExp(req.query.search, "i");
  const [items, total] = await Promise.all([
    Branch.find(query).populate("manager", "name email phone").sort({ name: 1 }).skip(skip).limit(limit).lean(),
    Branch.countDocuments(query)
  ]);
  sendResponse(res, { message: "Branches fetched", data: { items: items.map(item => ({ ...item, branchCode: item.branchCode || "MAIN" })), total, page, limit } });
});

const createBranch = asyncHandler(async (req, res) => {
  if (req.user.role !== "superadmin") throw Object.assign(new Error("Only superadmin can create branches"), { statusCode: 403 });
  const { name, branchCode, address, phone, email, manager, status, description, metadata } = req.body;
  const normalizedBranchCode = typeof branchCode === "string" ? branchCode.trim().toUpperCase() : "";
  if (!name?.trim() || !normalizedBranchCode) throw Object.assign(new Error("Branch name and code are required"), { statusCode: 400 });
  if (!/^[A-Z0-9][A-Z0-9_-]{1,19}$/.test(normalizedBranchCode)) {
    throw Object.assign(new Error("Branch code must be 2-20 characters and contain only letters, numbers, hyphens, or underscores."), { statusCode: 400 });
  }
  const existing = await Branch.exists({ gymId: req.gymId, branchCode: normalizedBranchCode });
  if (existing) throw Object.assign(new Error(`Branch code ${normalizedBranchCode} already exists.`), { statusCode: 409 });
  try {
    const branch = await Branch.create({ gymId: req.gymId, name: name.trim(), branchCode: normalizedBranchCode, address, phone, email, manager: manager || undefined, status, description, metadata });
    sendResponse(res, { status: 201, message: "Branch created", data: branch });
  } catch (error) {
    if (error?.code === 11000 && error?.keyPattern?.gymId && error?.keyPattern?.branchCode) {
      throw Object.assign(new Error(`Branch code ${normalizedBranchCode} already exists.`), { statusCode: 409 });
    }
    throw error;
  }
});

const updateBranch = asyncHandler(async (req, res) => {
  const branch = await Branch.findOne({ _id: req.params.id, ...branchFilter(req) });
  if (!branch) throw Object.assign(new Error("Branch not found"), { statusCode: 404 });

  let updated;
  if (req.user.role === "superadmin") {
    const { branchCode, ...rest } = req.body;
    if (branchCode !== undefined) {
      // Only Super Admin may rename branchCode. The cascade runs atomically.
      updated = (
        await renameBranchCode({
          gymId: req.gymId,
          branchId: branch._id,
          oldCode: branch.branchCode || "MAIN",
          newCode: branchCode,
          branchPatch: rest
        })
      ).branch;
    } else {
      updated = await Branch.findOneAndUpdate({ _id: branch._id, gymId: req.gymId }, rest, { new: true, runValidators: true });
    }
  } else {
    // Non-superadmins (Branch Admin): branchCode is stripped so an attempt to
    // change it is safely prevented server-side while other fields still edit.
    const { branchCode, ...rest } = req.body;
    updated = await Branch.findOneAndUpdate({ _id: branch._id, gymId: req.gymId }, rest, { new: true, runValidators: true });
  }
  if (!updated) throw Object.assign(new Error("Branch not found"), { statusCode: 404 });

  const populated = await Branch.findById(updated._id).populate("manager", "name email phone");
  sendResponse(res, { message: "Branch updated", data: populated });
});

const deleteBranch = asyncHandler(async (req, res) => {
  if (req.user.role !== "superadmin") {
    throw Object.assign(new Error("Only superadmin can delete branches"), { statusCode: 403 });
  }
  const branch = await Branch.findOne({ _id: req.params.id, gymId: req.gymId });
  if (!branch) throw Object.assign(new Error("Branch not found"), { statusCode: 404 });
  const [members, staff] = await Promise.all([
    Member.countDocuments({ gymId: req.gymId, branchCode: branch.branchCode }),
    User.countDocuments({ gymId: req.gymId, branchCode: branch.branchCode, role: { $in: ["admin", "trainer"] } })
  ]);
  if (members || staff) throw Object.assign(new Error("Branch has dependent members or staff. Deactivate it instead."), { statusCode: 409 });
  await branch.deleteOne();
  sendResponse(res, { message: "Branch deleted", data: {} });
});

const getBranchOverview = asyncHandler(async (req, res) => {
  const branch = await Branch.findOne({ _id: req.params.id, ...branchFilter(req) }).lean();
  if (!branch) throw Object.assign(new Error("Branch not found"), { statusCode: 404 });
  const branchCode = branch.branchCode || "MAIN";
  const memberMatch = { gymId: req.gymId, branchCode };
  // Trainer isolation: trainers only see their assigned members in branch overview.
  if (req.user && req.user.role === "trainer") {
    memberMatch.trainer = req.user._id;
  }
  const memberIds = await Member.find(memberMatch).distinct("_id");
  const [totalMembers, activeMembers, staff, revenue, payments, attendance, activeMemberships, expiringMemberships, expiredMemberships, plans] = await Promise.all([
    Member.countDocuments(memberMatch), Member.countDocuments({ ...memberMatch, status: "active", isActivePlan: true }), User.countDocuments({ gymId: req.gymId, branchCode: branch.branchCode, role: { $in: ["admin", "trainer"] } }),
    Payment.aggregate([{ $match: { gymId: req.gymId, member: { $in: memberIds } } }, { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } }]),
    Payment.countDocuments({ gymId: req.gymId, member: { $in: memberIds } }), Attendance.countDocuments({ gymId: req.gymId, member: { $in: memberIds }, deletedAt: null }),
    Member.countDocuments({ ...memberMatch, isActivePlan: true, status: { $in: ["active", "pending"] } }), Member.countDocuments({ ...memberMatch, membershipExpiryDate: { $gte: new Date(), $lte: new Date(Date.now() + 14 * 86400000) } }), Member.countDocuments({ ...memberMatch, status: { $in: ["expired", "cancelled", "inactive"] } }),
    Member.aggregate([{ $match: memberMatch }, { $group: { _id: "$currentPlan", count: { $sum: 1 } } }, { $lookup: { from: "plans", localField: "_id", foreignField: "_id", as: "plan" } }, { $project: { _id: 1, count: 1, name: { $arrayElemAt: ["$plan.name", 0] } } }, { $sort: { count: -1 } }])
  ]);
  sendResponse(res, { message: "Branch overview fetched", data: { branch, kpis: { totalMembers, activeMembers, staff, revenue: revenue[0]?.total || 0, payments, attendance, activeMemberships, expiringMemberships, expiredMemberships }, plans } });
});

module.exports = { listBranches, createBranch, updateBranch, deleteBranch, getBranchOverview };