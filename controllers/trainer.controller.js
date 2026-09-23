const User = require("../models/user.model");
const Member = require("../models/member.model");
const AuditLog = require("../models/audit.model");
const { asyncHandler } = require("../utils/asyncHandler");
const { sendResponse } = require("../utils/response");
const { getPagination } = require("../utils/pagination");
const { enforceBranchOwnership } = require("../middlewares/branchScope.middleware");

const listTrainers = asyncHandler(async (req, res) => {
  const { skip, limit, page } = getPagination(req.query);
  const query = { gymId: req.gymId, role: "trainer" };

  if (req.user && req.user.role !== "superadmin") {
    query.branchCode = (req.user.branchCode || "MAIN").trim().toUpperCase();
  } else if (req.query.branchCode && req.query.branchCode !== "ALL" && req.query.branchCode !== "all") {
    query.branchCode = req.query.branchCode.trim().toUpperCase();
  }

  if (req.query.search) {
    query.name = new RegExp(req.query.search, "i");
  }

  const [items, total] = await Promise.all([
    User.find(query).select("-password -refreshTokens").sort({ createdAt: -1 }).skip(skip).limit(limit),
    User.countDocuments(query)
  ]);
  sendResponse(res, { message: "Trainers fetched", data: { items, total, page, limit } });
});

const createTrainer = asyncHandler(async (req, res) => {
  const { name, email, phone, password, specialty, status, branchCode = "MAIN" } = req.body;
  
  const scopedBranchCode = req.user.role === "superadmin"
    ? (branchCode || "MAIN").trim().toUpperCase()
    : (req.user.branchCode || "MAIN").trim().toUpperCase();

  const existing = await User.findOne({ gymId: req.gymId, email: email?.toLowerCase().trim() });
  if (existing) {
    throw Object.assign(new Error("A user with this email already exists in this gym"), { statusCode: 409 });
  }

  const trainer = await User.create({
    gymId: req.gymId,
    name,
    email: email?.toLowerCase().trim(),
    phone,
    password: password || "Password123",
    role: "trainer",
    specialty,
    status: status || "active",
    branchCode: scopedBranchCode
  });

  sendResponse(res, {
    status: 201,
    message: "Trainer created",
    data: {
      _id: trainer._id,
      name: trainer.name,
      email: trainer.email,
      phone: trainer.phone,
      role: trainer.role,
      specialty: trainer.specialty,
      status: trainer.status,
      branchCode: trainer.branchCode
    }
  });
});

const updateTrainer = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, branchCode, ...otherData } = req.body;
  
  const oldTrainer = await User.findOne({ _id: id, gymId: req.gymId, role: "trainer" });
  if (!oldTrainer) throw Object.assign(new Error("Trainer not found"), { statusCode: 404 });
  if (!enforceBranchOwnership(oldTrainer.branchCode, req)) {
    throw Object.assign(new Error("Trainer not found in your branch"), { statusCode: 404 });
  }

  const updatePayload = { ...otherData };
  if (status) {
    updatePayload.status = status;
    if (status === 'inactive') {
      updatePayload.refreshTokens = [];
    }
  }

  if (req.user.role === "superadmin" && branchCode) {
    updatePayload.branchCode = branchCode.trim().toUpperCase();
  }

  const trainer = await User.findByIdAndUpdate(
    id,
    { $set: updatePayload },
    { new: true, runValidators: true }
  ).select("-password -refreshTokens");
  
  if (status && status !== oldTrainer.status) {
    await AuditLog.create({
      gymId: req.gymId,
      targetId: trainer._id,
      targetType: "Trainer",
      action: status === 'inactive' ? "DEACTIVATE_TRAINER" : "REACTIVATE_TRAINER",
      performedBy: req.user._id,
      oldValues: { status: oldTrainer.status },
      newValues: { status: trainer.status },
      reason: req.body.reason || "Administrative update"
    });
  }
  
  sendResponse(res, { message: "Trainer updated", data: trainer });
});

const deleteTrainer = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const trainer = await User.findOne({ _id: id, gymId: req.gymId, role: "trainer" });
  if (!trainer) throw Object.assign(new Error("Trainer not found"), { statusCode: 404 });
  if (!enforceBranchOwnership(trainer.branchCode, req)) {
    throw Object.assign(new Error("Trainer not found in your branch"), { statusCode: 404 });
  }

  // Check if any active members are assigned to this trainer
  const assignedCount = await Member.countDocuments({ trainer: id, gymId: req.gymId, status: { $ne: "inactive" } });
  if (assignedCount > 0) {
    throw Object.assign(new Error("Cannot delete trainer with assigned active members. Reassign members first."), { statusCode: 409 });
  }

  await trainer.deleteOne();
  sendResponse(res, { message: "Trainer deleted" });
});

module.exports = { listTrainers, createTrainer, updateTrainer, deleteTrainer };
