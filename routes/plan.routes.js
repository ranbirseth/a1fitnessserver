const router = require("express").Router();
const { protect, authorize } = require("../middlewares/auth.middleware");
const { createPlan, listPlans, updatePlan, deletePlan, applyPlanToBranch, removePlanFromBranch, listPlanBranches } = require("../controllers/plan.controller");

router.use(protect);
router.get("/", listPlans);
router.post("/", authorize("superadmin"), createPlan);
router.patch("/:id", authorize("superadmin"), updatePlan);
router.delete("/:id", authorize("superadmin"), deletePlan);

router.post("/:planId/branches", applyPlanToBranch);
router.delete("/:planId/branches", removePlanFromBranch);
router.get("/:planId/branches", listPlanBranches);

module.exports = router;
