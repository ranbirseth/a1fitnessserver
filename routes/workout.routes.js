const router = require("express").Router();
const { protect, authorize } = require("../middlewares/auth.middleware");
const { branchScope } = require("../middlewares/branchScope.middleware");
const {
  createWorkoutTemplate,
  getWorkoutTemplates,
  updateWorkoutTemplate,
  deleteWorkoutPlan,
  applyWorkoutTemplateToBranch,
  removeWorkoutTemplateFromBranch,
  listWorkoutTemplateBranches,
  assignWorkoutToMember,
  getMemberWorkout
} = require("../controllers/workout.controller");

router.use(protect, branchScope);

// Member routes
router.get("/my-workout", authorize("member"), getMemberWorkout);

// Template library
router.get("/templates", authorize("view_workout"), getWorkoutTemplates);
router.post("/templates", authorize("superadmin"), createWorkoutTemplate);
router.patch("/templates/:id", authorize("superadmin"), updateWorkoutTemplate);
router.delete("/:id", authorize("superadmin"), deleteWorkoutPlan);

// Branch application (reusable template <-> branch)
router.post("/templates/:templateId/branches", authorize("superadmin"), applyWorkoutTemplateToBranch);
router.delete("/templates/:templateId/branches", authorize("superadmin"), removeWorkoutTemplateFromBranch);
router.get("/templates/:templateId/branches", authorize("view_workout"), listWorkoutTemplateBranches);

// Assignment
router.post("/assign", authorize("assign_workout"), assignWorkoutToMember);

module.exports = router;