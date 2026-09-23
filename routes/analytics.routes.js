const router = require("express").Router();
const { protect, authorize } = require("../middlewares/auth.middleware");
const { branchScope } = require("../middlewares/branchScope.middleware");
const {
  getReportOverview,
  getFilterOptions,
  getRevenueTable,
  getMembershipTable,
  exportReport,
} = require("../controllers/analytics.controller");

router.use(protect, authorize("admin", "trainer"), branchScope);
router.get("/overview", getReportOverview);
router.get("/filters", getFilterOptions);
router.get("/revenue", getRevenueTable);
router.get("/memberships", getMembershipTable);
router.get("/export", exportReport);

module.exports = router;