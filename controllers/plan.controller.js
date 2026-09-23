const Plan = require("../models/plan.model");
const PlanBranch = require("../models/planBranch.model");
const Member = require("../models/member.model");
const { Branch } = require("../models/generic.model");
const { asyncHandler } = require("../utils/asyncHandler");
const { sendResponse } = require("../utils/response");
const { getPagination } = require("../utils/pagination");
const { enforceBranchOwnership } = require("../middlewares/branchScope.middleware");

const createPlan = asyncHandler(async (req, res) => {
  const { name, price, duration, features } = req.body;
  if (!name || price === undefined || !duration) {
    throw Object.assign(new Error("Missing required fields: name, price, duration"), { statusCode: 400 });
  }
  if (price < 0 || duration < 1) {
    throw Object.assign(new Error("Invalid values for price or duration"), { statusCode: 400 });
  }

  const existing = await Plan.findOne({ gymId: req.gymId, name: name.trim() });
  if (existing) {
    throw Object.assign(new Error(`Plan "${name}" already exists`), { statusCode: 409 });
  }

  const plan = await Plan.create({
    gymId: req.gymId,
    name: name.trim(),
    price,
    duration,
    features
  });
  sendResponse(res, { status: 201, message: "Plan created", data: plan });
});

const listPlans = asyncHandler(async (req, res) => {
  const { skip, limit, page } = getPagination(req.query);
  const query = { gymId: req.gymId };

  if (req.user && req.user.role !== "superadmin") {
    const userBranch = (req.user.branchCode || "MAIN").trim().toUpperCase();
    const appliedPlanIds = await PlanBranch.distinct("planId", {
      gymId: req.gymId,
      branchCode: userBranch,
      status: "active"
    });
    query._id = { $in: appliedPlanIds };
  } else if (req.query.branchCode && req.query.branchCode !== "ALL" && req.query.branchCode !== "all") {
    const filterBranch = req.query.branchCode.trim().toUpperCase();
    const appliedPlanIds = await PlanBranch.distinct("planId", {
      gymId: req.gymId,
      branchCode: filterBranch,
      status: "active"
    });
    if (req.query.exact === "true") {
      query._id = { $in: appliedPlanIds };
    } else {
      query.$or = [
        { branchCode: null },
        { branchCode: "ALL" },
        { _id: { $in: appliedPlanIds } }
      ];
    }
  }

  if (req.query.search) query.name = new RegExp(req.query.search, "i");

  const [items, total] = await Promise.all([
    Plan.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Plan.countDocuments(query)
  ]);

  // Attach applied branch info to each plan
  if (items.length > 0) {
    const planIds = items.map(p => p._id);
    const planBranches = await PlanBranch.find({
      planId: { $in: planIds },
      status: "active"
    }).select("planId branchCode");
    const branchMap = {};
    planBranches.forEach(pb => {
      if (!branchMap[pb.planId]) branchMap[pb.planId] = [];
      branchMap[pb.planId].push(pb.branchCode);
    });
    items.forEach(plan => {
      plan._doc.appliedBranches = branchMap[plan._id] || [];
    });
  }

  sendResponse(res, { message: "Plans fetched", data: { items, total, page, limit } });
});

const updatePlan = asyncHandler(async (req, res) => {
  const { name, price, duration, features } = req.body;
  if (price !== undefined && price < 0) throw Object.assign(new Error("Price cannot be negative"), { statusCode: 400 });
  if (duration !== undefined && duration < 1) throw Object.assign(new Error("Duration must be at least 1 day"), { statusCode: 400 });
  
  const plan = await Plan.findOne({ _id: req.params.id, gymId: req.gymId });
  if (!plan) throw Object.assign(new Error("Plan not found"), { statusCode: 404 });

  if (req.user.role !== "superadmin") {
    if (!plan.branchCode || plan.branchCode === "ALL" || !enforceBranchOwnership(plan.branchCode, req)) {
      throw Object.assign(new Error("You do not have permission to modify this plan"), { statusCode: 403 });
    }
  }

  if (name !== undefined) plan.name = name.trim();
  if (price !== undefined) plan.price = price;
  if (duration !== undefined) plan.duration = duration;
  if (features !== undefined) plan.features = features;

  await plan.save();
  sendResponse(res, { message: "Plan updated", data: plan });
});

const deletePlan = asyncHandler(async (req, res) => {
  const plan = await Plan.findOne({ _id: req.params.id, gymId: req.gymId });
  if (!plan) throw Object.assign(new Error("Plan not found"), { statusCode: 404 });

  if (req.user.role !== "superadmin") {
    if (!plan.branchCode || plan.branchCode === "ALL" || !enforceBranchOwnership(plan.branchCode, req)) {
      throw Object.assign(new Error("You do not have permission to delete this plan"), { statusCode: 403 });
    }
  }

  const memberCount = await Member.countDocuments({ currentPlan: req.params.id, gymId: req.gymId, status: "active" });
  if (memberCount > 0) {
    throw Object.assign(new Error("Cannot delete plan assigned to active members"), { statusCode: 400 });
  }

  await PlanBranch.deleteMany({ planId: req.params.id, gymId: req.gymId });
  await plan.deleteOne();
  sendResponse(res, { message: "Plan deleted", data: {} });
});

const applyPlanToBranch = asyncHandler(async (req, res) => {
  if (req.user.role !== "superadmin") {
    throw Object.assign(new Error("Only superadmin can apply plans to branches"), { statusCode: 403 });
  }

  const { branchCode } = req.body;
  if (!branchCode) {
    throw Object.assign(new Error("branchCode is required"), { statusCode: 400 });
  }

  const plan = await Plan.findOne({ _id: req.params.planId, gymId: req.gymId });
  if (!plan) throw Object.assign(new Error("Plan not found"), { statusCode: 404 });

  const normalizedBranch = branchCode.trim().toUpperCase();
  const branch = await Branch.findOne({ gymId: req.gymId, branchCode: normalizedBranch });
  if (!branch) throw Object.assign(new Error(`Branch "${normalizedBranch}" not found`), { statusCode: 404 });

  const existing = await PlanBranch.findOne({
    gymId: req.gymId,
    planId: plan._id,
    branchCode: normalizedBranch
  });
  if (existing) {
    if (existing.status === "active") {
      throw Object.assign(new Error(`Plan is already applied to branch ${normalizedBranch}`), { statusCode: 409 });
    }
    existing.status = "active";
    await existing.save();
    sendResponse(res, { message: `Plan applied to branch ${normalizedBranch}`, data: existing });
    return;
  }

  const planBranch = await PlanBranch.create({
    gymId: req.gymId,
    planId: plan._id,
    branchCode: normalizedBranch,
    status: "active"
  });
  sendResponse(res, { status: 201, message: `Plan applied to branch ${normalizedBranch}`, data: planBranch });
});

const removePlanFromBranch = asyncHandler(async (req, res) => {
  if (req.user.role !== "superadmin") {
    throw Object.assign(new Error("Only superadmin can remove plans from branches"), { statusCode: 403 });
  }

  const { branchCode } = req.body;
  if (!branchCode) {
    throw Object.assign(new Error("branchCode is required"), { statusCode: 400 });
  }

  const plan = await Plan.findOne({ _id: req.params.planId, gymId: req.gymId });
  if (!plan) throw Object.assign(new Error("Plan not found"), { statusCode: 404 });

  const normalizedBranch = branchCode.trim().toUpperCase();
  const planBranch = await PlanBranch.findOne({
    gymId: req.gymId,
    planId: plan._id,
    branchCode: normalizedBranch
  });
  if (!planBranch) {
    throw Object.assign(new Error(`Plan is not applied to branch ${normalizedBranch}`), { statusCode: 404 });
  }

  // Check for active members using this plan in this branch
  const activeMembers = await Member.countDocuments({
    currentPlan: plan._id,
    gymId: req.gymId,
    branchCode: normalizedBranch,
    status: "active"
  });
  if (activeMembers > 0) {
    throw Object.assign(
      new Error(`Cannot remove plan: ${activeMembers} active member(s) in ${normalizedBranch} are using this plan`),
      { statusCode: 400 }
    );
  }

  await planBranch.deleteOne();
  sendResponse(res, { message: `Plan removed from branch ${normalizedBranch}`, data: {} });
});

const listPlanBranches = asyncHandler(async (req, res) => {
  const plan = await Plan.findOne({ _id: req.params.planId, gymId: req.gymId });
  if (!plan) throw Object.assign(new Error("Plan not found"), { statusCode: 404 });

  const planBranches = await PlanBranch.find({
    gymId: req.gymId,
    planId: plan._id,
    status: "active"
  }).sort({ branchCode: 1 });

  sendResponse(res, { message: "Plan branches fetched", data: planBranches });
});

module.exports = { createPlan, listPlans, updatePlan, deletePlan, applyPlanToBranch, removePlanFromBranch, listPlanBranches };
