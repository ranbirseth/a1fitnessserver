const Progress = require("../models/progress.model");
const Member = require("../models/member.model");
const { asyncHandler } = require("../utils/asyncHandler");
const { sendResponse } = require("../utils/response");
const { enforceBranchOwnership } = require("../middlewares/branchScope.middleware");

const findScopedMember = (req, memberId) => {
  const query = { _id: memberId };
  if (req.user.role !== "superadmin") query.gymId = req.gymId;
  return Member.findOne(query);
};

const createProgress = asyncHandler(async (req, res) => {
  const member = await findScopedMember(req, req.body.member);
  if (!member) throw Object.assign(new Error("Member not found"), { statusCode: 404 });
  if (!enforceBranchOwnership(member.branchCode, req)) {
    throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
  }
  // Trainer isolation: trainers may only log progress for their assigned members.
  if (req.user.role === "trainer") {
    if (!member.trainer || String(member.trainer) !== String(req.user._id)) {
      throw Object.assign(new Error("You can only log progress for members assigned to you"), { statusCode: 403 });
    }
  }
  const bmi = req.body.weightKg / ((req.body.heightCm / 100) ** 2);
  const progress = await Progress.create({ ...req.body, gymId: member.gymId, bmi: Number(bmi.toFixed(2)) });
  sendResponse(res, { status: 201, message: "Progress logged", data: progress });
});

const listProgress = asyncHandler(async (req, res) => {
  const member = await findScopedMember(req, req.params.memberId);
  if (!member) throw Object.assign(new Error("Member not found"), { statusCode: 404 });
  if (req.user.role === "member") {
    if (!req.member || !member._id.equals(req.member._id)) {
      throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
    }
  } else if (!enforceBranchOwnership(member.branchCode, req)) {
    throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
  }
  // Trainer isolation: trainers may only view progress for their assigned members.
  if (req.user.role === "trainer") {
    if (!member.trainer || String(member.trainer) !== String(req.user._id)) {
      throw Object.assign(new Error("You can only view progress for members assigned to you"), { statusCode: 403 });
    }
  }
  sendResponse(res, { message: "Progress fetched", data: await Progress.find({ member: member._id }).sort({ createdAt: -1 }) });
});

module.exports = { createProgress, listProgress };
