const DietPlan = require("../models/diet.model");
const DietTemplateBranch = require("../models/dietTemplateBranch.model");
const Member = require("../models/member.model");
const { asyncHandler } = require("../utils/asyncHandler");
const { sendResponse } = require("../utils/response");
const { AppError } = require("../utils/appError");
const { enforceBranchOwnership } = require("../middlewares/branchScope.middleware");
const {
  normalizeBranchCodes,
  assertBranchesExist,
  getAppliedBranchCodes,
  isTemplateAppliedToBranch,
  applyTemplateToBranches
} = require("../services/templateBranch.service");

const resolveBranch = (req) => {
  const isSuperAdmin = req.user && req.user.role === "superadmin";
  // Non-superadmins are locked to their assigned branch; never trust client input.
  if (!isSuperAdmin) {
    const assigned = (req.user && req.user.branchCode) || req.branchCode || "MAIN";
    return String(assigned).trim().toUpperCase();
  }
  // Superadmin: respect the explicitly selected branch (body, query, or first of `branches`),
  // falling back to MAIN.
  const selected = (req.body && req.body.branchCode) || req.branchCode;
  if (selected && selected !== "ALL" && selected !== "all") {
    return String(selected).trim().toUpperCase();
  }
  const firstBranch = req.body && Array.isArray(req.body.branches) && req.body.branches[0];
  if (firstBranch) return String(firstBranch).trim().toUpperCase();
  return "MAIN";
};

// Templates CRUD
const createDietTemplate = asyncHandler(async (req, res) => {
  const { branches, ...templateBody } = req.body;
  const codes = normalizeBranchCodes(branches);

  // Validate selected branches BEFORE creating anything so a failed validation
  // can never leave an orphan template behind. assertBranchesExist also scopes
  // the lookup to req.gymId, preventing cross-gym branch assignment.
  if (codes.length) {
    await assertBranchesExist(req.gymId, codes);
  }

  let diet;
  try {
    diet = await DietPlan.create({
      ...templateBody,
      gymId: req.gymId,
      branchCode: resolveBranch(req),
      createdBy: req.user._id,
      isTemplate: true
    });

    const appliedBranches = codes.length
      ? await applyTemplateToBranches({
          gymId: req.gymId,
          templateId: diet._id,
          branchCodes: codes,
          junctionModel: DietTemplateBranch
        })
      : [];

    if (appliedBranches.length) {
      diet.branchCode = appliedBranches[0].branchCode;
      await diet.save();
    }
    diet._doc.appliedBranches = appliedBranches.map((p) => p.branchCode);

    sendResponse(res, { status: 201, message: "Diet template created", data: diet });
  } catch (error) {
    // Rollback the partial insert so a failed relationship write never leaves
    // an orphan template in the database.
    if (diet) {
      await DietTemplateBranch.deleteMany({ templateId: diet._id });
      await DietPlan.deleteOne({ _id: diet._id });
    }
    throw error;
  }
});

const getDietTemplates = asyncHandler(async (req, res) => {
  const query = { gymId: req.gymId, isTemplate: true };
  const isSuperAdmin = req.user && req.user.role === "superadmin";

  if (!isSuperAdmin) {
    // Branch Admins / Trainers are locked to their own branch. They must never
    // be able to request another branch's templates via query/body params.
    const userBranch = (req.user.branchCode || "MAIN").trim().toUpperCase();
    const appliedIds = await DietTemplateBranch.distinct("templateId", {
      gymId: req.gymId,
      branchCode: userBranch,
      status: "active"
    });
    query._id = { $in: appliedIds };
  } else if (req.branchCode) {
    // Superadmin may optionally filter by a single branch.
    const appliedIds = await DietTemplateBranch.distinct("templateId", {
      gymId: req.gymId,
      branchCode: req.branchCode,
      status: "active"
    });
    query._id = { $in: appliedIds };
  }

  const templates = await DietPlan.find(query).sort({ createdAt: -1 });

  if (templates.length > 0) {
    const templateIds = templates.map((t) => t._id);
    const rows = await DietTemplateBranch.find({
      templateId: { $in: templateIds },
      status: "active"
    }).select("templateId branchCode").lean();
    const branchMap = {};
    rows.forEach((row) => {
      if (!branchMap[row.templateId]) branchMap[row.templateId] = [];
      branchMap[row.templateId].push(row.branchCode);
    });
    templates.forEach((template) => {
      template._doc.appliedBranches = (branchMap[template._id] || []).sort();
    });
  }

  sendResponse(res, { message: "Templates fetched", data: templates });
});

const updateDietTemplate = asyncHandler(async (req, res) => {
  const { branches: _omit, ...updateFields } = req.body;
  const allowedFields = ["name", "goal", "calories", "meals"];
  const patch = {};
  allowedFields.forEach((field) => {
    if (updateFields[field] !== undefined) patch[field] = updateFields[field];
  });

  const diet = await DietPlan.findOne({
    _id: req.params.id,
    gymId: req.gymId,
    isTemplate: true
  });
  if (!diet) throw new AppError("Diet template not found", 404);

  Object.assign(diet, patch);
  await diet.save();

  diet._doc.appliedBranches = await getAppliedBranchCodes({
    gymId: req.gymId,
    templateId: diet._id,
    junctionModel: DietTemplateBranch
  });

  sendResponse(res, { message: "Diet template updated", data: diet });
});

const deleteDietPlan = asyncHandler(async (req, res) => {
  const diet = await DietPlan.findOneAndDelete({ _id: req.params.id, gymId: req.gymId });
  if (!diet) throw new AppError("Diet template not found", 404);
  await DietTemplateBranch.deleteMany({ templateId: req.params.id, gymId: req.gymId });
  sendResponse(res, { message: "Diet plan deleted" });
});

// Branch application (Super Admin only — enforced in routes and here defensively)
const applyDietTemplateToBranch = asyncHandler(async (req, res) => {
  if (req.user.role !== "superadmin") {
    throw new AppError("Only superadmin can apply diet templates to branches", 403);
  }

  const { branchCode } = req.body;
  if (!branchCode) throw new AppError("branchCode is required", 400);

  const template = await DietPlan.findOne({
    _id: req.params.templateId,
    gymId: req.gymId,
    isTemplate: true
  });
  if (!template) throw new AppError("Diet template not found", 404);

  const normalizedBranch = branchCode.trim().toUpperCase();
  await assertBranchesExist(req.gymId, [normalizedBranch]);

  const existing = await DietTemplateBranch.findOne({
    gymId: req.gymId,
    templateId: template._id,
    branchCode: normalizedBranch
  });
  if (existing) {
    if (existing.status === "active") {
      throw new AppError(`Diet template is already applied to branch ${normalizedBranch}`, 409);
    }
    existing.status = "active";
    await existing.save();
    sendResponse(res, {
      message: `Diet template applied to branch ${normalizedBranch}`,
      data: existing
    });
    return;
  }

  await DietTemplateBranch.create({
    gymId: req.gymId,
    templateId: template._id,
    branchCode: normalizedBranch,
    status: "active"
  });
  sendResponse(res, {
    status: 201,
    message: `Diet template applied to branch ${normalizedBranch}`,
    data: { templateId: template._id, branchCode: normalizedBranch, status: "active" }
  });
});

const removeDietTemplateFromBranch = asyncHandler(async (req, res) => {
  if (req.user.role !== "superadmin") {
    throw new AppError("Only superadmin can remove diet templates from branches", 403);
  }

  const { branchCode } = req.body;
  if (!branchCode) throw new AppError("branchCode is required", 400);

  const template = await DietPlan.findOne({
    _id: req.params.templateId,
    gymId: req.gymId,
    isTemplate: true
  });
  if (!template) throw new AppError("Diet template not found", 404);

  const normalizedBranch = branchCode.trim().toUpperCase();
  const junction = await DietTemplateBranch.findOne({
    gymId: req.gymId,
    templateId: template._id,
    branchCode: normalizedBranch
  });
  if (!junction) {
    throw new AppError(`Diet template is not applied to branch ${normalizedBranch}`, 404);
  }

  // Safety rule (mirrors Plan removal): block removal while active members in
  // that branch are assigned a copy derived from this template.
  const memberIds = await Member.find({
    gymId: req.gymId,
    branchCode: normalizedBranch,
    status: "active"
  }).distinct("_id");
  const inUse = await DietPlan.countDocuments({
    gymId: req.gymId,
    branchCode: normalizedBranch,
    isTemplate: false,
    sourceTemplate: template._id,
    assignedTo: { $in: memberIds }
  });
  if (inUse > 0) {
    throw new AppError(
      `Cannot remove diet template: ${inUse} active member(s) in ${normalizedBranch} are using it`,
      400
    );
  }

  await junction.deleteOne();
  sendResponse(res, {
    message: `Diet template removed from branch ${normalizedBranch}`,
    data: { templateId: template._id, branchCode: normalizedBranch }
  });
});

const listDietTemplateBranches = asyncHandler(async (req, res) => {
  const template = await DietPlan.findOne({
    _id: req.params.templateId,
    gymId: req.gymId,
    isTemplate: true
  });
  if (!template) throw new AppError("Diet template not found", 404);

  const rows = await DietTemplateBranch.find({
    gymId: req.gymId,
    templateId: template._id
  }).sort({ branchCode: 1 });

  sendResponse(res, { message: "Diet template branches fetched", data: rows });
});

// Assignment
const assignDietToMember = asyncHandler(async (req, res) => {
  const { memberId, templateId, customPlan } = req.body;
  if (!templateId && !customPlan) {
    throw new AppError("Either templateId or customPlan must be provided", 400);
  }

  const member = await Member.findOne({ _id: memberId, gymId: req.gymId });
  if (!member) throw new AppError("Member not found", 404);

  // Branch isolation: non-superadmins (trainers, branch admins) may only
  // assign diets to members in their OWN branch. Branch is derived from the
  // authenticated user, never from client-supplied branchCode.
  if (req.user && req.user.role !== "superadmin" && !enforceBranchOwnership(member.branchCode, req)) {
    throw new AppError("Member not found in your branch", 404);
  }
  // Trainer isolation: trainers may only assign diets to their assigned members.
  if (req.user && req.user.role === "trainer") {
    if (!member.trainer || String(member.trainer) !== String(req.user._id)) {
      throw new AppError("You can only assign diets to members assigned to you", 403);
    }
  }

  const memberBranch = (member.branchCode || "MAIN").trim().toUpperCase();

  let dietPlan;
  if (templateId) {
    const template = await DietPlan.findOne({ _id: templateId, gymId: req.gymId, isTemplate: true });
    if (!template) throw new AppError("Template not found", 404);

    // Branch isolation: non-superadmins can only use templates applied to the
    // member's branch. The branch is derived server-side (member's own branch),
    // never from a client-supplied branch code.
    if (req.user && req.user.role !== "superadmin") {
      const applied = await isTemplateAppliedToBranch({
        gymId: req.gymId,
        templateId: template._id,
        branchCode: memberBranch,
        junctionModel: DietTemplateBranch
      });
      if (!applied) {
        throw new AppError("Template is not available for your branch", 403);
      }
    }

    // Create a copy for the member (kept traceable to the template).
    const templateObj = template.toObject();
    dietPlan = await DietPlan.create({
      gymId: req.gymId,
      branchCode: memberBranch,
      name: templateObj.name,
      goal: templateObj.goal,
      calories: templateObj.calories,
      meals: JSON.parse(JSON.stringify(templateObj.meals)),
      isTemplate: false,
      sourceTemplate: template._id,
      assignedTo: memberId,
      createdBy: req.user._id
    });
  } else if (customPlan) {
    dietPlan = await DietPlan.create({
      ...customPlan,
      gymId: req.gymId,
      branchCode: memberBranch || req.branchCode || "MAIN",
      isTemplate: false,
      assignedTo: memberId,
      createdBy: req.user._id
    });
  }

  if (!dietPlan) throw new AppError("Failed to create diet plan", 500);

  member.assignedDiet = dietPlan._id;
  await member.save();

  // Populate the created diet before sending response
  await dietPlan.populate("createdBy", "name email");
  sendResponse(res, { message: "Diet assigned successfully", data: dietPlan });
});

const getMemberDiet = asyncHandler(async (req, res) => {
  const member = await Member.findOne({ user: req.user._id }).populate("assignedDiet");
  if (!member) throw new AppError("Member profile not found", 404);
  sendResponse(res, { message: "Diet fetched", data: member.assignedDiet });
});

module.exports = {
  createDietTemplate,
  getDietTemplates,
  updateDietTemplate,
  deleteDietPlan,
  applyDietTemplateToBranch,
  removeDietTemplateFromBranch,
  listDietTemplateBranches,
  assignDietToMember,
  getMemberDiet
};