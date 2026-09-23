const router = require("express").Router();
const { protect, authorize } = require("../middlewares/auth.middleware");
const { listAdmins, createAdmin, updateAdmin, deleteAdmin } = require("../controllers/admin.controller");

router.use(protect, authorize("superadmin"));
router.get("/", listAdmins);
router.post("/", createAdmin);
router.patch("/:id", updateAdmin);
router.delete("/:id", deleteAdmin);

module.exports = router;
