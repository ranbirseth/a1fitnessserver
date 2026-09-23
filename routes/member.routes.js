const router = require("express").Router();
const { protect, authorize } = require("../middlewares/auth.middleware");
const { branchScope } = require("../middlewares/branchScope.middleware");
const upload = require("../utils/upload");
const {
  createMember,
  listMembers,
  searchMembers,
  getMember,
  updateMember,
  deleteMember,
  assignPlan,
  renewPlan,
  upgradePlan,
  cancelPlan,
  freezePlan,
  resumePlan,
  approveMember,
  linkBiometric,
  getMyProfile,
  updateMyProfile
} = require("../controllers/member.controller");

router.use(protect, branchScope);
router.get("/", authorize("view_member"), listMembers);
router.get("/search", authorize("view_member"), searchMembers);
router.post("/", authorize("create_member"), upload.single("photo"), createMember);
router.get("/profile/me", authorize("member"), getMyProfile);
router.patch("/profile/me", authorize("member"), upload.single("photo"), updateMyProfile);
router.get("/:id", getMember);
router.put("/:id", authorize("update_member"), upload.single("photo"), updateMember);
router.delete("/:id", authorize("delete_member"), deleteMember);
router.patch("/:id/assign-plan", authorize("manage_plans"), assignPlan);
router.patch("/:id/renew-plan", authorize("manage_plans"), renewPlan);
router.patch("/:id/upgrade-plan", authorize("manage_plans"), upgradePlan);
router.patch("/:id/cancel-plan", authorize("manage_plans"), cancelPlan);
router.patch("/:id/freeze-plan", authorize("manage_plans"), freezePlan);
router.patch("/:id/resume-plan", authorize("manage_plans"), resumePlan);
router.patch("/:id/approve", authorize("approve_member"), approveMember);
router.post("/:id/link-biometric", authorize("update_member"), linkBiometric);

module.exports = router;
