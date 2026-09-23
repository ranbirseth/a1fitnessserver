const { Referral } = require("../models/generic.model");
const Member = require("../models/member.model");
const { asyncHandler } = require("../utils/asyncHandler");
const { sendResponse } = require("../utils/response");
const { getPagination } = require("../utils/pagination");

const getReferralBranchFilter = (req) => {
  if (req.user.role !== "superadmin") {
    const branchCode = (req.user.branchCode || "MAIN").trim().toUpperCase();
    return { "metadata.branchCode": { $in: [branchCode, null] } };
  }
  const requested = req.query.branchCode;
  if (requested && requested !== "ALL" && requested !== "all") {
    return { "metadata.branchCode": requested.trim().toUpperCase() };
  }
  return null;
};

const applyReferral = asyncHandler(async (req, res) => {
  const { code, referredMemberId, benefit } = req.body;
  if (!code || !referredMemberId) {
    throw Object.assign(new Error("code and referredMemberId are required"), { statusCode: 400 });
  }
  const referredMember = await Member.findOne({ _id: referredMemberId, gymId: req.gymId }).select("_id").lean();
  if (!referredMember) {
    throw Object.assign(new Error("Referred member not found in this gym"), { statusCode: 404 });
  }
  const branchCode = req.user.role === "superadmin"
    ? (req.body.branchCode || "MAIN").trim().toUpperCase()
    : (req.user.branchCode || "MAIN").trim().toUpperCase();
  const referral = await Referral.create({
    gymId: req.gymId,
    name: `Referral ${code}`,
    description: "Referral applied",
    metadata: { code, referredMemberId, benefit: benefit || "5% discount", appliedAt: new Date().toISOString(), branchCode }
  });
  sendResponse(res, { status: 201, message: "Referral applied", data: referral });
});

const listReferrals = asyncHandler(async (req, res) => {
  const { skip, limit, page } = getPagination(req.query);
  const filter = { gymId: req.gymId };
  const branchFilter = getReferralBranchFilter(req);
  if (branchFilter) Object.assign(filter, branchFilter);
  const [items, total] = await Promise.all([
    Referral.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Referral.countDocuments(filter)
  ]);
  sendResponse(res, { message: "Referrals fetched", data: { items, total, page, limit } });
});

module.exports = { applyReferral, listReferrals, getReferralBranchFilter };
