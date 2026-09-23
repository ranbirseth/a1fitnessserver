const router = require("express").Router();
const { protect, protectOptional, authorize, checkPlanAccess } = require("../middlewares/auth.middleware");
const { branchScope } = require("../middlewares/branchScope.middleware");
const {
  markAttendance,
  memberCheckIn,
  memberCheckOut,
  getMyAttendance,
  getTodayStatus,
  getMyStats,
  getRealTimeStatus,
  exportMyAttendance,
  history,
  checkIn,
  checkOut,
  updateAttendance,
  deleteAttendance,
  faceVerifyPlaceholder
} = require("../controllers/attendance.controller");

router.post("/mark", protectOptional, markAttendance);

router.use(protect, branchScope);

router.post("/check-in", authorize("member"), checkPlanAccess, memberCheckIn);
router.post("/check-out", authorize("member"), checkPlanAccess, memberCheckOut);
router.get("/me", authorize("member"), checkPlanAccess, getMyAttendance);
router.get("/me/today", authorize("member"), checkPlanAccess, getTodayStatus);
router.get("/me/stats", authorize("member"), checkPlanAccess, getMyStats);
router.get("/me/export", authorize("member"), checkPlanAccess, exportMyAttendance);
router.get("/me/realtime", authorize("member"), checkPlanAccess, getRealTimeStatus);

router.get("/", authorize("admin", "trainer"), history);
router.post("/face-verify", authorize("admin", "trainer"), faceVerifyPlaceholder);
router.post("/check-in", authorize("admin", "trainer"), checkIn);
router.patch("/check-out/:id", authorize("admin", "trainer"), checkOut);
router.put("/:id", authorize("admin", "superadmin"), updateAttendance);
router.delete("/:id", authorize("admin", "superadmin"), deleteAttendance);

module.exports = router;