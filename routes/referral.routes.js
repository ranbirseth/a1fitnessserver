const router = require("express").Router();
const { protect, authorize } = require("../middlewares/auth.middleware");
const { applyReferral, listReferrals } = require("../controllers/referral.controller");

router.use(protect);
router.get("/", authorize("admin", "trainer"), listReferrals);
router.post("/apply", authorize("admin", "trainer", "member"), applyReferral);

module.exports = router;
