const router = require("express").Router();
const { protect } = require("../middlewares/auth.middleware");
const { listNotifications, markAsRead } = require("../controllers/notification.controller");

router.get("/", protect, listNotifications);
router.patch("/:id/read", protect, markAsRead);

module.exports = router;
