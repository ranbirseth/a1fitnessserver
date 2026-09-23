const router = require("express").Router();
const { protect, authorize } = require("../middlewares/auth.middleware");
const { branchScope } = require("../middlewares/branchScope.middleware");
const { listBranches, createBranch, updateBranch, deleteBranch, getBranchOverview } = require("../controllers/branch.controller");

router.use(protect, authorize("admin"));
router.get("/", listBranches);
router.post("/", createBranch);
router.get("/:id/overview", getBranchOverview);
router.patch("/:id", updateBranch);
router.delete("/:id", deleteBranch);

module.exports = router;