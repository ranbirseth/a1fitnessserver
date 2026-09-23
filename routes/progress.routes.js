const router = require("express").Router();
const { protect, authorize } = require("../middlewares/auth.middleware");
const { createProgress, listProgress } = require("../controllers/progress.controller");

router.use(protect);
router.post("/", authorize("admin", "trainer"), createProgress);
router.get("/:memberId", authorize("admin", "trainer", "member"), listProgress);

module.exports = router;
