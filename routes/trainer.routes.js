const router = require("express").Router();
const { protect, authorize } = require("../middlewares/auth.middleware");
const { branchScope } = require("../middlewares/branchScope.middleware");
const { listTrainers, createTrainer, updateTrainer, deleteTrainer } = require("../controllers/trainer.controller");

router.use(protect, authorize("admin"), branchScope);
router.get("/", listTrainers);
router.post("/", createTrainer);
router.patch("/:id", updateTrainer);
router.delete("/:id", deleteTrainer);

module.exports = router;
