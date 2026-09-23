const router = require("express").Router();
const { protect, authorize } = require("../middlewares/auth.middleware");
const { branchScope } = require("../middlewares/branchScope.middleware");
const { getStats } = require("../controllers/dashboard.controller");

router.get("/stats", protect, authorize("admin", "trainer"), branchScope, getStats);

module.exports = router;
