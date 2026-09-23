const { Branch } = require("../models/generic.model");

/**
 * Normalizes a user-supplied branch selection (single value or array) into a
 * de-duplicated, uppercased list of real branch codes. The "ALL" sentinel is
 * never treated as an actual branch — it only means "no filter" in listings.
 */
const normalizeBranchCodes = (input) => {
  if (input === undefined || input === null) return [];
  const list = Array.isArray(input) ? input : [input];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const code = String(item || "").trim().toUpperCase();
    if (code && code !== "ALL" && code !== "all" && !seen.has(code)) {
      seen.add(code);
      out.push(code);
    }
  }
  return out;
};

/**
 * Validates that every branch code actually exists for the gym.
 * Super Admin's branch selection must be validated, never blindly trusted.
 */
const assertBranchesExist = async (gymId, branchCodes) => {
  const existing = await Branch.find({ gymId, branchCode: { $in: branchCodes } })
    .select("branchCode")
    .lean();
  const found = new Set(existing.map((b) => b.branchCode));
  const missing = branchCodes.filter((code) => !found.has(code));
  if (missing.length) {
    throw Object.assign(new Error(`Branch(es) not found: ${missing.join(", ")}`), { statusCode: 404 });
  }
};

const getAppliedBranchCodes = async ({ gymId, templateId, junctionModel }) => {
  const rows = await junctionModel
    .find({ gymId, templateId, status: "active" })
    .select("branchCode")
    .sort({ branchCode: 1 })
    .lean();
  return rows.map((r) => r.branchCode);
};

const isTemplateAppliedToBranch = async ({ gymId, templateId, branchCode, junctionModel }) => {
  const code = String(branchCode || "").trim().toUpperCase();
  if (!code) return false;
  const row = await junctionModel.exists({ gymId, templateId, branchCode: code, status: "active" });
  return row != null;
};

const applyTemplateToBranches = async ({ gymId, templateId, branchCodes, junctionModel }) => {
  const codes = normalizeBranchCodes(branchCodes);
  if (codes.length === 0) return [];
  await assertBranchesExist(gymId, codes);

  const rows = [];
  for (const branchCode of codes) {
    const existing = await junctionModel.findOne({ gymId, templateId, branchCode });
    if (existing) {
      if (existing.status === "inactive") {
        existing.status = "active";
        await existing.save();
      }
      rows.push(existing);
    } else {
      rows.push(
        await junctionModel.create({ gymId, templateId, branchCode, status: "active" })
      );
    }
  }
  return rows;
};

/**
 * One-time migration: existing templates were stored with a single branchCode
 * field. Build the junction rows from that field so no template disappears or
 * duplicates get created. Idempotent — safe to run on every boot.
 */
const backfillTemplateBranches = async () => {
  const WorkoutPlan = require("../models/workout.model");
  const DietPlan = require("../models/diet.model");
  const WorkoutTemplateBranch = require("../models/workoutTemplateBranch.model");
  const DietTemplateBranch = require("../models/dietTemplateBranch.model");

  const pairs = [
    [WorkoutPlan, WorkoutTemplateBranch],
    [DietPlan, DietTemplateBranch]
  ];

  for (const [planModel, junctionModel] of pairs) {
    const templates = await planModel.find({ isTemplate: true }).select("_id gymId branchCode").lean();
    for (const template of templates) {
      const hasJunction = await junctionModel.exists({ templateId: template._id });
      if (hasJunction) continue;
      const codes = normalizeBranchCodes([template.branchCode || "MAIN"]);
      if (codes.length) {
        await junctionModel.create({
          gymId: template.gymId,
          templateId: template._id,
          branchCode: codes[0],
          status: "active"
        });
      }
    }
  }
};

module.exports = {
  normalizeBranchCodes,
  assertBranchesExist,
  getAppliedBranchCodes,
  isTemplateAppliedToBranch,
  applyTemplateToBranches,
  backfillTemplateBranches
};