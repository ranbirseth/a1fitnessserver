const router = require("express").Router();
const { protect, authorize } = require("../middlewares/auth.middleware");
const { branchScope } = require("../middlewares/branchScope.middleware");
const { bookClassSlot, listBookings, cancelBooking } = require("../controllers/booking.controller");

router.use(protect, branchScope);
router.get("/", authorize("admin", "trainer", "member"), listBookings);
router.post("/", authorize("admin", "trainer", "member"), bookClassSlot);
router.patch("/:id/cancel", authorize("admin", "trainer", "member"), cancelBooking);

module.exports = router;
