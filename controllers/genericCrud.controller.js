const { asyncHandler } = require("../utils/asyncHandler");
const { sendResponse } = require("../utils/response");
const { getPagination } = require("../utils/pagination");
const Member = require("../models/member.model");
const User = require("../models/user.model");
const { Branch } = require("../models/generic.model");
const { getReferralBranchFilter } = require("./referral.controller");
const { renameBranchCode } = require("../services/branchRename.service");

const makeCrud = (Model, name) => ({
  create: asyncHandler(async (req, res) => {
    const doc = await Model.create({ ...req.body, ...(Model.modelName === "Branch" && req.user.role !== "superadmin" ? { branchCode: req.user.branchCode || "MAIN" } : {}), gymId: req.gymId });
    sendResponse(res, { status: 201, message: `${name} created`, data: doc });
  }),
  list: asyncHandler(async (req, res) => {
    const { skip, limit, page } = getPagination(req.query);
    const query = { gymId: req.gymId, ...(Model.modelName === "Branch" && req.query.branchCode ? { branchCode: req.query.branchCode } : {}) };
    if (Model.modelName === "Referral") {
      const branchFilter = getReferralBranchFilter(req);
      if (branchFilter) Object.assign(query, branchFilter);
    }
    if (req.query.search) query.name = new RegExp(req.query.search, "i");
    const [items, total] = await Promise.all([
      Model.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Model.countDocuments(query)
    ]);
    sendResponse(res, { message: `${name} list fetched`, data: { items, total, page, limit } });
  }),
  update: asyncHandler(async (req, res) => {
    if (Model.modelName === "Branch") {
      const scope = { _id: req.params.id, gymId: req.gymId, ...(req.query.branchCode ? { branchCode: req.query.branchCode } : {}) };
      const branch = await Branch.findOne(scope);
      if (!branch) throw Object.assign(new Error(`${name} not found`), { statusCode: 404 });

      if (req.user.role !== "superadmin") {
        // Branch Admin/Trainer must not change branchCode - strip it server-side.
        const { branchCode, ...rest } = req.body;
        const doc = await Branch.findOneAndUpdate({ _id: branch._id, gymId: req.gymId }, rest, { new: true, runValidators: true });
        return sendResponse(res, { message: `${name} updated`, data: doc });
      }

      const { branchCode, ...rest } = req.body;
      if (branchCode !== undefined) {
        const result = await renameBranchCode({
          gymId: req.gymId,
          branchId: branch._id,
          oldCode: branch.branchCode || "MAIN",
          newCode: branchCode,
          branchPatch: rest
        });
        return sendResponse(res, { message: `${name} updated`, data: result.branch });
      }
      const doc = await Branch.findOneAndUpdate({ _id: branch._id, gymId: req.gymId }, rest, { new: true, runValidators: true });
      return sendResponse(res, { message: `${name} updated`, data: doc });
    }

    const entityScope = { _id: req.params.id, gymId: req.gymId, ...(Model.modelName === "Branch" && req.query.branchCode ? { branchCode: req.query.branchCode } : {}) };
    const payload = req.body;
    const doc = await Model.findOneAndUpdate(entityScope, payload, { new: true, runValidators: true });
    sendResponse(res, { message: `${name} updated`, data: doc });
  }),
  remove: asyncHandler(async (req, res) => {
    const scope = { _id: req.params.id, gymId: req.gymId, ...(Model.modelName === "Branch" && req.query.branchCode ? { branchCode: req.query.branchCode } : {}) };
    if (Model.modelName === "Branch") {
      const branch = await Model.findOne(scope).lean();
      if (!branch) throw Object.assign(new Error(`${name} not found`), { statusCode: 404 });
      const branchCode = branch.branchCode || "MAIN";
      const [members, staff] = await Promise.all([Member.countDocuments({ gymId: req.gymId, branchCode }), User.countDocuments({ gymId: req.gymId, branchCode, role: { $in: ["admin", "trainer"] } })]);
      if (members || staff) throw Object.assign(new Error("Branch has dependent members or staff. Deactivate it instead."), { statusCode: 409 });
    }
    await Model.findOneAndDelete(scope);
    sendResponse(res, { message: `${name} deleted`, data: {} });
  })
});

module.exports = { makeCrud };
