const User = require("../models/user.model");
const { Branch } = require("../models/generic.model");
const { asyncHandler } = require("../utils/asyncHandler");
const { sendResponse } = require("../utils/response");
const { getPagination } = require("../utils/pagination");

const listAdmins = asyncHandler(async (req, res) => {
  const { skip, limit, page } = getPagination(req.query);
  const query = { gymId: req.gymId, role: "admin" };

  if (req.query.search) {
    query.name = new RegExp(req.query.search, "i");
  }

  const [items, total] = await Promise.all([
    User.find(query).select("-password -refreshTokens").sort({ createdAt: -1 }).skip(skip).limit(limit),
    User.countDocuments(query)
  ]);
  sendResponse(res, { message: "Admins fetched", data: { items, total, page, limit } });
});

const createAdmin = asyncHandler(async (req, res) => {
  const { name, email, phone, password, branchCode } = req.body;

  if (!name?.trim()) throw Object.assign(new Error("Name is required"), { statusCode: 400 });
  if (!email?.trim()) throw Object.assign(new Error("Email is required"), { statusCode: 400 });
  if (!branchCode?.trim()) throw Object.assign(new Error("Branch assignment is required"), { statusCode: 400 });

  const normalizedBranchCode = branchCode.trim().toUpperCase();

  const branch = await Branch.findOne({ gymId: req.gymId, branchCode: normalizedBranchCode });
  if (!branch) throw Object.assign(new Error("Branch not found"), { statusCode: 404 });
  if (branch.status === "inactive") throw Object.assign(new Error("Cannot assign admin to an inactive branch"), { statusCode: 400 });

  const existing = await User.findOne({ gymId: req.gymId, email: email.toLowerCase().trim() });
  if (existing) throw Object.assign(new Error("A user with this email already exists in this gym"), { statusCode: 409 });

  const admin = await User.create({
    gymId: req.gymId,
    name: name.trim(),
    email: email.toLowerCase().trim(),
    phone: phone?.trim() || undefined,
    password: password || "Password123",
    role: "admin",
    branchCode: normalizedBranchCode
  });

  sendResponse(res, {
    status: 201,
    message: "Admin created",
    data: {
      _id: admin._id,
      name: admin.name,
      email: admin.email,
      phone: admin.phone,
      role: admin.role,
      status: admin.status,
      branchCode: admin.branchCode
    }
  });
});

const updateAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, email, phone, password, branchCode, status } = req.body;

  const admin = await User.findOne({ _id: id, gymId: req.gymId, role: "admin" });
  if (!admin) throw Object.assign(new Error("Admin not found"), { statusCode: 404 });

  const updatePayload = {};

  if (name !== undefined) updatePayload.name = name.trim();
  if (phone !== undefined) updatePayload.phone = phone.trim();
  if (password) updatePayload.password = password;

  if (email && email.toLowerCase().trim() !== admin.email) {
    const existing = await User.findOne({ gymId: req.gymId, email: email.toLowerCase().trim(), _id: { $ne: id } });
    if (existing) throw Object.assign(new Error("A user with this email already exists in this gym"), { statusCode: 409 });
    updatePayload.email = email.toLowerCase().trim();
  }

  if (status) {
    updatePayload.status = status;
    if (status === "inactive") {
      updatePayload.refreshTokens = [];
    }
  }

  if (branchCode) {
    const normalizedBranchCode = branchCode.trim().toUpperCase();
    const branch = await Branch.findOne({ gymId: req.gymId, branchCode: normalizedBranchCode });
    if (!branch) throw Object.assign(new Error("Branch not found"), { statusCode: 404 });
    if (branch.status === "inactive") throw Object.assign(new Error("Cannot assign admin to an inactive branch"), { statusCode: 400 });
    updatePayload.branchCode = normalizedBranchCode;
  }

  const updated = await User.findByIdAndUpdate(
    id,
    { $set: updatePayload },
    { new: true, runValidators: true }
  ).select("-password -refreshTokens");

  sendResponse(res, { message: "Admin updated", data: updated });
});

const deleteAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const admin = await User.findOne({ _id: id, gymId: req.gymId, role: "admin" });
  if (!admin) throw Object.assign(new Error("Admin not found"), { statusCode: 404 });

  await admin.deleteOne();
  sendResponse(res, { message: "Admin deleted" });
});

module.exports = { listAdmins, createAdmin, updateAdmin, deleteAdmin };
