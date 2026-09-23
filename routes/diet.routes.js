const router = require("express").Router();
const { protect, authorize } = require("../middlewares/auth.middleware");
const { branchScope } = require("../middlewares/branchScope.middleware");
const {
  createDietTemplate,
  getDietTemplates,
  updateDietTemplate,
  deleteDietPlan,
  applyDietTemplateToBranch,
  removeDietTemplateFromBranch,
  listDietTemplateBranches,
  assignDietToMember,
  getMemberDiet
} = require("../controllers/diet.controller");

router.use(protect, branchScope);

// Member routes
router.get("/my-diet", authorize("member"), getMemberDiet);

// Template library
router.get("/templates", authorize("view_diet"), getDietTemplates);
router.post("/templates", authorize("superadmin"), createDietTemplate);
router.patch("/templates/:id", authorize("superadmin"), updateDietTemplate);
router.delete("/:id", authorize("superadmin"), deleteDietPlan);

// Branch application (reusable template <-> branch)
router.post("/templates/:templateId/branches", authorize("superadmin"), applyDietTemplateToBranch);
router.delete("/templates/:templateId/branches", authorize("superadmin"), removeDietTemplateFromBranch);
router.get("/templates/:templateId/branches", authorize("view_diet"), listDietTemplateBranches);

// Assignment
router.post("/assign", authorize("assign_diet"), assignDietToMember);

module.exports = router;