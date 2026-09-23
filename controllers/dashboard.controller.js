const Member = require("../models/member.model");
const Payment = require("../models/payment.model");
const User = require("../models/user.model");
const Attendance = require("../models/attendance.model");
const { asyncHandler } = require("../utils/asyncHandler");
const { sendResponse } = require("../utils/response");
const { getCache, setCache } = require("../services/cache.service");

const getStats = asyncHandler(async (req, res) => {
  const activeBranch = req.user.role === "superadmin"
    ? (req.query.branchCode && req.query.branchCode !== "ALL" && req.query.branchCode !== "all" ? req.query.branchCode.trim().toUpperCase() : undefined)
    : (req.user.branchCode || "MAIN").trim().toUpperCase();

  const branchFilter = activeBranch ? { branchCode: activeBranch } : {};
  const isTrainer = req.user.role === "trainer";
  const trainerFilter = isTrainer ? { trainer: req.user._id } : {};
  const cacheKey = `dashboard:stats:${req.gymId}:${activeBranch || "all"}${isTrainer ? `:t:${req.user._id}` : ""}`;
  const cached = await getCache(cacheKey);
  if (cached) return sendResponse(res, { message: "Dashboard stats fetched (cache)", data: cached });

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  const memberIdsInBranch = activeBranch
    ? await Member.find({ gymId: req.gymId, branchCode: activeBranch }).distinct("_id")
    : null;

  // For Trainers, attendance must be restricted to the members assigned to the
  // authenticated Trainer (Member.trainer === req.user._id), never another
  // trainer's members or unassigned members, while preserving branch isolation.
  const trainerMemberIds = isTrainer
    ? await Member.find({
        gymId: req.gymId,
        trainer: req.user._id,
        ...(activeBranch ? { branchCode: activeBranch } : {})
      }).distinct("_id")
    : null;

  const paymentMatch = {
    gymId: req.gymId,
    status: "paid",
    // Scope by the member's CURRENT branch so a reassigned member's payments
    // follow them instead of leaking into the old branch's dashboard.
    ...(activeBranch ? { member: { $in: memberIdsInBranch } } : {})
  };

  const attendanceMatch = {
    gymId: req.gymId,
    deletedAt: null,
    checkIn: { $gte: startOfDay, $lte: endOfDay },
    // Scope by the member's CURRENT branch (every attendance is member-linked).
    ...(activeBranch ? { member: { $in: memberIdsInBranch } } : {}),
    // Trainers only see attendance for their own assigned members.
    ...(isTrainer ? { member: { $in: trainerMemberIds } } : {})
  };

  const [totalMembers, activePlans, revenueObj, activeTrainers, attendanceToday, revenueAnalytics, recentActivities] = await Promise.all([
    Member.countDocuments({ gymId: req.gymId, ...branchFilter, ...trainerFilter }),
    Member.countDocuments({ gymId: req.gymId, ...branchFilter, isActivePlan: true }),
    Payment.aggregate([
      { $match: paymentMatch },
      { $group: { _id: null, total: { $sum: "$amount" } } }
    ]),
    User.countDocuments({ gymId: req.gymId, role: "trainer", ...branchFilter }),
    Attendance.countDocuments(attendanceMatch),
    // Revenue analytics for last 7 days
    Payment.aggregate([
      { 
        $match: { 
          ...paymentMatch,
          date: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } 
        } 
      },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$date" } },
          total: { $sum: "$amount" }
        }
      },
      { $sort: { _id: 1 } }
    ]),
    // Recent activities (mix of new members, payments, and attendance)
    Promise.all([
      Member.find({ gymId: req.gymId, ...branchFilter, ...trainerFilter }).sort({ createdAt: -1 }).limit(3).populate("user", "name"),
      Payment.find(paymentMatch).sort({ createdAt: -1 }).limit(3).populate({ path: "member", populate: { path: "user", select: "name" } }),
      Attendance.find({ gymId: req.gymId, deletedAt: null, ...(activeBranch ? { member: { $in: memberIdsInBranch } } : {}) }).sort({ checkIn: -1 }).limit(3).populate({ path: "member", populate: { path: "user", select: "name" } })
    ])
  ]);

  // Process activities into a uniform format
  const processedActivities = [
    ...recentActivities[0].map(m => ({ 
      text: `New member: ${m.user?.name || 'Unknown'}`, 
      time: m.createdAt, 
      color: "var(--clr-primary)" 
    })),
    ...recentActivities[1].map(p => ({ 
      text: `Payment of ₹${p.amount} from ${p.member?.user?.name || 'Unknown'}`, 
      time: p.createdAt, 
      color: "var(--clr-success)" 
    })),
    ...recentActivities[2].map(a => ({ 
      text: `${a.member?.user?.name || 'Unknown'} checked in`, 
      time: a.checkIn || a.createdAt, 
      color: "var(--clr-secondary)" 
    }))
  ].sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 5);

  const data = { 
    totalMembers, 
    activePlans, 
    // Trainers must never receive the Monthly Revenue figure (financial data
    // is not exposed to Trainers even though the card is hidden in the UI).
    revenue: isTrainer ? 0 : (revenueObj[0]?.total || 0),
    activeTrainers,
    attendanceToday,
    // Revenue Analytics (Last 7 Days) is financial data: not exposed to
    // Trainers even though the chart is hidden in the UI.
    revenueAnalytics: isTrainer ? [] : revenueAnalytics,
    recentActivities: processedActivities,
    branchCode: activeBranch || "ALL"
  };
  
  await setCache(cacheKey, data, 15);
  sendResponse(res, { message: "Dashboard stats fetched", data });
});

module.exports = { getStats };
