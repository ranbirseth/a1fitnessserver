const Notification = require("../models/notification.model");
const User = require("../models/user.model");
const { asyncHandler } = require("../utils/asyncHandler");
const { sendResponse } = require("../utils/response");
const { getPagination } = require("../utils/pagination");

const getStaffUserIds = async (req) => {
  const userFilter = { gymId: req.user.gymId };
  if (req.user.role !== "superadmin") {
    userFilter.branchCode = (req.user.branchCode || "MAIN").trim().toUpperCase();
  } else if (req.query.branchCode && req.query.branchCode !== "ALL" && req.query.branchCode !== "all") {
    userFilter.branchCode = req.query.branchCode.trim().toUpperCase();
  }
  const users = await User.find(userFilter).select("_id").lean();
  return users.map((u) => u._id);
};

const listNotifications = asyncHandler(async (req, res) => {
  const { skip, limit, page } = getPagination(req.query);
  const filter = req.user.role === "member"
    ? { user: req.user._id }
    : { user: { $in: await getStaffUserIds(req) } };
  const [items, total, unread] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Notification.countDocuments(filter),
    Notification.countDocuments({ ...filter, isRead: false })
  ]);
  sendResponse(res, { message: "Notifications fetched", data: { items, total, unread, page, limit } });
});

const markAsRead = asyncHandler(async (req, res) => {
  const notification = await Notification.findById(req.params.id);
  if (!notification) throw Object.assign(new Error("Notification not found"), { statusCode: 404 });

  const isOwner = notification.user && notification.user.toString() === req.user._id.toString();
  if (!isOwner) {
    if (!["superadmin", "admin", "trainer"].includes(req.user.role)) {
      throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
    }
    if (req.user.role !== "superadmin") {
      const owner = await User.findById(notification.user).select("gymId branchCode").lean();
      const sameGym = owner && owner.gymId === req.user.gymId;
      const sameBranch = owner
        && ((owner.branchCode || "MAIN").trim().toUpperCase() === (req.user.branchCode || "MAIN").trim().toUpperCase());
      if (!sameGym || !sameBranch) {
        throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
      }
    }
  }

  notification.isRead = true;
  await notification.save();
  sendResponse(res, { message: "Notification marked as read", data: notification });
});

module.exports = { listNotifications, markAsRead };
