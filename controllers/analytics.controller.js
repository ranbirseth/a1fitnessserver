const mongoose = require("mongoose");
const { subDays, startOfDay, endOfDay, startOfWeek, endOfWeek, startOfMonth, endOfMonth, startOfYear, endOfYear, format, eachDayOfInterval, eachMonthOfInterval } = require("date-fns");
const PDFDocument = require("pdfkit");
const Member = require("../models/member.model");
const Payment = require("../models/payment.model");
const Attendance = require("../models/attendance.model");
const Plan = require("../models/plan.model");
const PlanBranch = require("../models/planBranch.model");
const User = require("../models/user.model");
const { Branch } = require("../models/generic.model");
const { asyncHandler } = require("../utils/asyncHandler");
const { sendResponse } = require("../utils/response");

const CURRENCY_SYMBOL = "₹";

function parseRange(req, defaultDays = 30) {
  const { range, dateFrom, dateTo } = req.query;
  const now = new Date();
  let start;
  let end;
  if (dateFrom || dateTo) {
    start = dateFrom ? startOfDay(new Date(dateFrom)) : startOfDay(subDays(now, defaultDays));
    end = dateTo ? endOfDay(new Date(dateTo)) : endOfDay(now);
  } else if (range === "today") {
    start = startOfDay(now);
    end = endOfDay(now);
  } else if (range === "this_week") {
    start = startOfWeek(now, { weekStartsOn: 1 });
    end = endOfWeek(now, { weekStartsOn: 1 });
  } else if (range === "this_month") {
    start = startOfMonth(now);
    end = endOfMonth(now);
  } else if (range === "this_year") {
    start = startOfYear(now);
    end = endOfYear(now);
  } else {
    start = startOfDay(subDays(now, defaultDays));
    end = endOfDay(now);
  }
  return { start, end };
}

function applyCommonMatch(req) {
  const { gymId } = req;
  const { planId, trainerId, branchCode, memberStatus, paymentStatus, paymentMethod } = req.query;
  const match = { gymId };
  if (planId) match.plan = new mongoose.Types.ObjectId(planId);
  if (paymentStatus) match.status = paymentStatus;
  if (paymentMethod) match.method = paymentMethod;
  return match;
}

function getDateBuckets(start, end, granularity = "auto") {
  const totalDays = Math.max(1, Math.round((end - start) / (24 * 60 * 60 * 1000)));
  const mode =
    granularity === "daily" ? "daily" :
    granularity === "monthly" ? "monthly" :
    totalDays <= 45 ? "daily" :
    totalDays <= 370 ? "monthly" : "monthly";
  const labels = [];
  const keys = [];
  if (mode === "daily") {
    const days = eachDayOfInterval({ start, end });
    for (const d of days) {
      keys.push(format(d, "yyyy-MM-dd"));
      labels.push(format(d, "MMM d"));
    }
  } else {
    const months = eachMonthOfInterval({ start, end });
    for (const m of months) {
      keys.push(format(m, "yyyy-MM"));
      labels.push(format(m, "MMM yy"));
    }
  }
  return { mode, keys, labels };
}

function fillSeries(keys, aggregateRows, valueKey = "total") {
  const map = new Map(aggregateRows.map(r => [r._id, r[valueKey]]));
  return keys.map(k => ({ _id: k, [valueKey]: map.get(k) || 0 }));
}

function filterOptionsQuery(req) {
  const { planId, branchCode, memberStatus, paymentStatus, paymentMethod } = req.query;
  const effectiveBranch = req.user && req.user.role !== "superadmin"
    ? (req.user.branchCode || "MAIN").trim().toUpperCase()
    : (branchCode && branchCode !== "ALL" && branchCode !== "all" ? branchCode.trim().toUpperCase() : undefined);

  return {
    planId: planId || undefined,
    branchCode: effectiveBranch,
    memberStatus: memberStatus || undefined,
    paymentStatus: paymentStatus || undefined,
    paymentMethod: paymentMethod || undefined,
  };
}

const getReportOverview = asyncHandler(async (req, res) => {
  const { start, end } = parseRange(req, 30);
  const gymId = req.gymId;
  const filters = filterOptionsQuery(req);

  const paymentMatch = { gymId, date: { $gte: start, $lte: end } };
  if (filters.planId) paymentMatch.plan = new mongoose.Types.ObjectId(filters.planId);
  if (filters.paymentStatus) paymentMatch.status = filters.paymentStatus;
  if (filters.paymentMethod) paymentMatch.method = filters.paymentMethod;

  const memberBaseMatch = { gymId };
  if (filters.branchCode) memberBaseMatch.branchCode = filters.branchCode;
  if (filters.memberStatus) memberBaseMatch.status = filters.memberStatus;
  if (filters.planId) memberBaseMatch.currentPlan = new mongoose.Types.ObjectId(filters.planId);
  // Trainer isolation: trainers only see analytics for their assigned members.
  if (req.user && req.user.role === "trainer") {
    memberBaseMatch.trainer = req.user._id;
  }

  const paymentsPipeline = [
    filters.branchCode
      ? { $lookup: { from: "members", localField: "member", foreignField: "_id", as: "_member" } }
      : null,
    filters.branchCode ? { $unwind: "$_member" } : null,
    {
      $match: {
        ...paymentMatch,
        ...(filters.branchCode ? { "_member.branchCode": filters.branchCode } : {}),
      },
    },
  ].filter(Boolean);

  const [
    revenueTotal,
    revenueByStatus,
    revenueByMethod,
    revenueByPlan,
    revenueSeries,
    newMembersCount,
    activeMembersCount,
    inactiveMembersCount,
    membersByStatus,
    membersByPlan,
    newMemberSeries,
    renewalsCount,
    expiringCount,
    expiredCount,
    attendanceCount,
    attendanceSeries,
    attendanceByStatus,
    paymentCounts,
  ] = await Promise.all([
    Payment.aggregate([
      ...paymentsPipeline,
      { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),
    Payment.aggregate([
      ...paymentsPipeline,
      { $group: { _id: "$status", total: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),
    Payment.aggregate([
      ...paymentsPipeline,
      { $group: { _id: "$method", total: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),
    Payment.aggregate([
      ...paymentsPipeline,
      { $group: { _id: "$plan", total: { $sum: "$amount" }, count: { $sum: 1 } } },
      { $lookup: { from: "plans", localField: "_id", foreignField: "_id", as: "plan" } },
      { $project: { _id: 1, total: 1, count: 1, name: { $arrayElemAt: ["$plan.name", 0] } } },
      { $sort: { total: -1 } },
    ]),
    (async () => {
      const { mode, keys } = getDateBuckets(start, end);
      const groupId =
        mode === "daily"
          ? { $dateToString: { format: "%Y-%m-%d", date: "$date" } }
          : { $dateToString: { format: "%Y-%m", date: "$date" } };
      const rows = await Payment.aggregate([
        ...paymentsPipeline,
        { $group: { _id: groupId, total: { $sum: "$amount" }, count: { $sum: 1 } } },
      ]);
      const filled = fillSeries(keys, rows, "total");
      const filledCount = fillSeries(keys, rows, "count");
      return filled.map((f, i) => ({
        _id: f._id,
        total: f.total,
        count: filledCount[i] ? filledCount[i].count : 0,
      }));
    })(),
    Member.countDocuments({
      ...memberBaseMatch,
      createdAt: { $gte: start, $lte: end },
    }),
    Member.countDocuments({
      ...memberBaseMatch,
      status: { $in: ["active", "pending"] },
      isActivePlan: true,
    }),
    Member.countDocuments({
      ...memberBaseMatch,
      status: { $in: ["expired", "cancelled", "inactive"] },
    }),
    Member.aggregate([
      { $match: memberBaseMatch },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    Member.aggregate([
      { $match: memberBaseMatch },
      { $group: { _id: "$currentPlan", count: { $sum: 1 } } },
      { $lookup: { from: "plans", localField: "_id", foreignField: "_id", as: "plan" } },
      { $project: { _id: 1, count: 1, name: { $arrayElemAt: ["$plan.name", 0] } } },
      { $sort: { count: -1 } },
    ]),
    (async () => {
      const { mode, keys } = getDateBuckets(start, end);
      const groupId =
        mode === "daily"
          ? { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }
          : { $dateToString: { format: "%Y-%m", date: "$createdAt" } };
      const rows = await Member.aggregate([
        { $match: { ...memberBaseMatch, createdAt: { $gte: start, $lte: end } } },
        { $group: { _id: groupId, count: { $sum: 1 } } },
      ]);
      return fillSeries(keys, rows, "count");
    })(),
    Payment.aggregate([
      ...paymentsPipeline,
      { $group: { _id: null, count: { $sum: 1 } } },
    ]).then(r => (r.length ? r[0].count : 0)),
    Member.countDocuments({
      ...memberBaseMatch,
      membershipExpiryDate: { $gte: end, $lte: new Date(end.getTime() + 14 * 24 * 60 * 60 * 1000) },
    }),
    Member.countDocuments({
      ...memberBaseMatch,
      membershipExpiryDate: { $lt: start },
      status: { $in: ["expired", "cancelled", "inactive"] },
    }),
    (async () => {
      const attMatch = { gymId, checkIn: { $gte: start, $lte: end }, deletedAt: null };
      const pipeline = [];
      if (filters.branchCode) {
        pipeline.push(
          { $lookup: { from: "members", localField: "member", foreignField: "_id", as: "_member" } },
          { $unwind: "$_member" },
          ...(filters.branchCode ? [{ $match: { "_member.branchCode": filters.branchCode } }] : [])
        );
      }
      pipeline.push({ $match: attMatch }, { $count: "count" });
      const r = await Attendance.aggregate(pipeline);
      return r.length ? r[0].count : 0;
    })(),
    (async () => {
      const { mode, keys } = getDateBuckets(start, end);
      const attMatch = { gymId, checkIn: { $gte: start, $lte: end }, deletedAt: null };
      const extra = [];
      if (filters.branchCode) {
        extra.push(
          { $lookup: { from: "members", localField: "member", foreignField: "_id", as: "_member" } },
          { $unwind: "$_member" },
          ...(filters.branchCode ? [{ $match: { "_member.branchCode": filters.branchCode } }] : [])
        );
      }
      const groupId =
        mode === "daily"
          ? { $dateToString: { format: "%Y-%m-%d", date: "$checkIn" } }
          : { $dateToString: { format: "%Y-%m", date: "$checkIn" } };
      const rows = await Attendance.aggregate([
        ...extra,
        { $match: attMatch },
        { $group: { _id: groupId, count: { $sum: 1 } } },
      ]);
      const normalizedRows = mode === "daily" ? rows : rows;
      return fillSeries(keys, normalizedRows, "count");
    })(),
    (async () => {
      const attMatch = { gymId, checkIn: { $gte: start, $lte: end }, deletedAt: null };
      const extra = [];
      if (filters.branchCode) {
        extra.push(
          { $lookup: { from: "members", localField: "member", foreignField: "_id", as: "_member" } },
          { $unwind: "$_member" },
          ...(filters.branchCode ? [{ $match: { "_member.branchCode": filters.branchCode } }] : [])
        );
      }
      return Attendance.aggregate([
        ...extra,
        { $match: attMatch },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]);
    })(),
    Payment.aggregate([
      ...paymentsPipeline,
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
  ]);

  const labels = getDateBuckets(start, end).labels;

  const totalRevenue = revenueTotal[0]?.total || 0;
  const totalTransactions = revenueTotal[0]?.count || 0;
  const paidTotal = revenueByStatus.find(r => r._id === "paid")?.total || 0;
  const pendingTotal = revenueByStatus.find(r => r._id === "pending")?.total || 0;
  const pendingPaymentsCount = paymentCounts.find(r => r._id === "pending")?.count || 0;

  return sendResponse(res, {
    message: "Analytics overview fetched",
    data: {
      kpis: {
        totalRevenue,
        totalTransactions,
        paidRevenue: paidTotal,
        pendingRevenue: pendingTotal,
        pendingPaymentsCount,
        newMembers: newMembersCount,
        activeMembers: activeMembersCount,
        inactiveMembers: inactiveMembersCount,
        renewalsCount,
        expiringCount,
        expiredCount,
        attendanceCount,
        avgRevenuePerTransaction: totalTransactions ? Math.round(totalRevenue / totalTransactions) : 0,
      },
      series: {
        labels,
        revenue: revenueSeries.map(r => r.total),
        revenueCounts: revenueSeries.map(r => r.count),
        newMembers: newMemberSeries.map(r => r.count),
        attendance: attendanceSeries.map(r => r.count),
      },
      breakdowns: {
        revenueByMethod,
        revenueByStatus,
        revenueByPlan,
        membersByStatus,
        membersByPlan,
        attendanceByStatus,
        paymentsByStatus: paymentCounts,
      },
      range: { start, end },
      filters,
    },
  });
});

const getFilterOptions = asyncHandler(async (req, res) => {
  const gymId = req.gymId;
  const branchQuery = { gymId };
  if (req.user && req.user.role !== "superadmin") {
    branchQuery.branchCode = (req.user.branchCode || "MAIN").trim().toUpperCase();
  }

  const plansQuery = { gymId };
  if (req.user && req.user.role !== "superadmin") {
    const userBranch = (req.user.branchCode || "MAIN").trim().toUpperCase();
    const appliedPlanIds = await PlanBranch.distinct("planId", {
      gymId,
      branchCode: userBranch,
      status: "active"
    });
    plansQuery._id = { $in: appliedPlanIds };
  }

  const [plans, branches, memberStatuses, paymentStatuses, paymentMethods, attendanceStatuses] = await Promise.all([
    Plan.find(plansQuery).sort({ name: 1 }).select("name price duration branchCode").lean(),
    Branch.find(branchQuery).sort({ name: 1 }).select("name branchCode status").lean(),
    Member.aggregate([{ $match: { gymId, ...(req.user?.role !== "superadmin" ? { branchCode: req.user.branchCode || "MAIN" } : {}), ...(req.user?.role === "trainer" ? { trainer: req.user._id } : {}) } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
    Payment.aggregate([{ $match: { gymId } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
    Payment.aggregate([{ $match: { gymId } }, { $group: { _id: "$method", count: { $sum: 1 } } }]),
    Attendance.aggregate([{ $match: { gymId, deletedAt: null } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
  ]);
  sendResponse(res, {
    message: "Analytics filter options fetched",
    data: {
      plans,
      branches: branches.length ? branches : [{ _id: "MAIN", branchCode: "MAIN", name: "Main Branch", status: "active" }],
      memberStatuses: memberStatuses.map(s => s._id).filter(Boolean),
      paymentStatuses: paymentStatuses.map(s => s._id).filter(Boolean),
      paymentMethods: paymentMethods.map(m => m._id).filter(Boolean),
      attendanceStatuses: attendanceStatuses.map(s => s._id).filter(Boolean),
    },
  });
});

const getRevenueTable = asyncHandler(async (req, res) => {
  const { start, end } = parseRange(req, 90);
  const gymId = req.gymId;
  const filters = filterOptionsQuery(req);
  const { mode, keys, labels } = getDateBuckets(start, end);
  const groupId =
    mode === "daily"
      ? { $dateToString: { format: "%Y-%m-%d", date: "$date" } }
      : { $dateToString: { format: "%Y-%m", date: "$date" } };

  const paymentMatch = { gymId, date: { $gte: start, $lte: end } };
  if (filters.planId) paymentMatch.plan = new mongoose.Types.ObjectId(filters.planId);
  if (filters.paymentStatus) paymentMatch.status = filters.paymentStatus;
  if (filters.paymentMethod) paymentMatch.method = filters.paymentMethod;

  const extra = [];
  if (filters.branchCode) {
    extra.push(
      { $lookup: { from: "members", localField: "member", foreignField: "_id", as: "_member" } },
      { $unwind: "$_member" },
      ...(filters.branchCode ? [{ $match: { "_member.branchCode": filters.branchCode } }] : [])
    );
  }

  const rows = await Payment.aggregate([
    ...extra,
    { $match: paymentMatch },
    { $group: { _id: groupId, total: { $sum: "$amount" }, count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);

  const map = new Map(rows.map(r => [r._id, r]));
  const items = keys.map((k, i) => {
    const r = map.get(k) || { total: 0, count: 0 };
    return { _id: k, label: labels[i], total: r.total || 0, count: r.count || 0 };
  });

  sendResponse(res, {
    message: "Revenue report fetched",
    data: {
      items,
      total: items.reduce((a, b) => a + b.total, 0),
      transactions: items.reduce((a, b) => a + b.count, 0),
      granularity: mode,
    },
  });
});

const getMembershipTable = asyncHandler(async (req, res) => {
  const gymId = req.gymId;
  const filters = filterOptionsQuery(req);
  const memberMatch = { gymId };
  if (filters.branchCode) memberMatch.branchCode = filters.branchCode;
  if (filters.memberStatus) memberMatch.status = filters.memberStatus;
  if (filters.planId) memberMatch.currentPlan = new mongoose.Types.ObjectId(filters.planId);
  // Trainer isolation: trainers only see membership data for their assigned members.
  if (req.user && req.user.role === "trainer") {
    memberMatch.trainer = req.user._id;
  }

  const byPlan = await Member.aggregate([
    { $match: memberMatch },
    { $group: { _id: "$currentPlan", count: { $sum: 1 } } },
    { $lookup: { from: "plans", localField: "_id", foreignField: "_id", as: "plan" } },
    { $project: { count: 1, plan: { $arrayElemAt: ["$plan", 0] } } },
  ]);

  const items = await Promise.all(
    byPlan.map(async p => {
      const planId = p.plan?._id;
      const baseMatch = { ...memberMatch, currentPlan: planId };
      const [active, expired, renewals] = await Promise.all([
        Member.countDocuments({ ...baseMatch, status: { $in: ["active", "pending"] }, isActivePlan: true }),
        Member.countDocuments({ ...baseMatch, status: { $in: ["expired", "cancelled", "inactive"] } }),
        Payment.countDocuments({
          gymId,
          ...(planId ? { plan: planId } : {}),
        }),
      ]);
      return {
        _id: p.plan?._id || null,
        name: p.plan?.name || "No plan",
        price: p.plan?.price ?? 0,
        totalMembers: p.count,
        activeMembers: active,
        expiredMembers: expired,
        totalRenewals: renewals,
      };
    })
  );

  sendResponse(res, {
    message: "Membership report fetched",
    data: {
      items: items.sort((a, b) => b.totalMembers - a.totalMembers),
      totals: {
        totalMembers: items.reduce((a, b) => a + b.totalMembers, 0),
        activeMembers: items.reduce((a, b) => a + b.activeMembers, 0),
        expiredMembers: items.reduce((a, b) => a + b.expiredMembers, 0),
        totalRenewals: items.reduce((a, b) => a + b.totalRenewals, 0),
      },
    },
  });
});

function escCsv(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.includes(",") || s.includes("\"") || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function sendCsv(res, filename, headers, rows) {
  const lines = [headers.map(h => escCsv(h)).join(",")];
  for (const row of rows) lines.push(row.map(c => escCsv(c)).join(","));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}.csv"`);
  res.status(200).send("\uFEFF" + lines.join("\n"));
}

const exportReport = asyncHandler(async (req, res) => {
  const { format: fmt = "csv", report = "overview" } = req.query;
  const filename = `A1-Fitness-${report}-${format(new Date(), "yyyy-MM-dd-HHmm")}`;

  if (fmt === "csv" || fmt === "excel") {
    if (report === "revenue") {
      const { start, end } = parseRange(req, 90);
      const filters = filterOptionsQuery(req);
      const { mode, keys, labels } = getDateBuckets(start, end);
      const groupId =
        mode === "daily"
          ? { $dateToString: { format: "%Y-%m-%d", date: "$date" } }
          : { $dateToString: { format: "%Y-%m", date: "$date" } };
      const paymentMatch = { gymId: req.gymId, date: { $gte: start, $lte: end } };
      if (filters.planId) paymentMatch.plan = new mongoose.Types.ObjectId(filters.planId);
      if (filters.paymentStatus) paymentMatch.status = filters.paymentStatus;
      if (filters.paymentMethod) paymentMatch.method = filters.paymentMethod;
      const paymentExtra = [];
      if (filters.branchCode) {
        paymentExtra.push(
          { $lookup: { from: "members", localField: "member", foreignField: "_id", as: "_member" } },
          { $unwind: "$_member" },
          { $match: { "_member.branchCode": filters.branchCode } }
        );
      }
      const rows = await Payment.aggregate([
        ...paymentExtra,
        { $match: paymentMatch },
        { $group: { _id: groupId, total: { $sum: "$amount" }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]);
      const map = new Map(rows.map(r => [r._id, r]));
      const tableRows = keys.map((k, i) => {
        const r = map.get(k) || { total: 0, count: 0 };
        return [labels[i], r.count || 0, r.total || 0];
      });
      sendCsv(res, filename, ["Period", "Total Transactions", "Total Revenue (INR)"], tableRows);
      return;
    }

    if (report === "membership") {
      const filters = filterOptionsQuery(req);
      const memberMatch = { gymId: req.gymId };
      if (filters.branchCode) memberMatch.branchCode = filters.branchCode;
      if (filters.memberStatus) memberMatch.status = filters.memberStatus;
      if (filters.planId) memberMatch.currentPlan = new mongoose.Types.ObjectId(filters.planId);
      const byPlan = await Member.aggregate([
        { $match: memberMatch },
        { $group: { _id: "$currentPlan", count: { $sum: 1 } } },
        { $lookup: { from: "plans", localField: "_id", foreignField: "_id", as: "plan" } },
        { $project: { count: 1, plan: { $arrayElemAt: ["$plan", 0] } } },
      ]);
      const rows = await Promise.all(
        byPlan.map(async p => {
          const planId = p.plan?._id;
          const baseMatch = { ...memberMatch, currentPlan: planId };
          const [active, expired, renewals] = await Promise.all([
            Member.countDocuments({ ...baseMatch, status: { $in: ["active", "pending"] }, isActivePlan: true }),
            Member.countDocuments({ ...baseMatch, status: { $in: ["expired", "cancelled", "inactive"] } }),
            Payment.countDocuments({
              gymId: req.gymId,
              ...(planId ? { plan: planId } : {}),
              ...(filters.paymentStatus ? { status: filters.paymentStatus } : {}),
              ...(filters.paymentMethod ? { method: filters.paymentMethod } : {}),
            }),
          ]);
          return [p.plan?.name || "No plan", p.count, active, expired, renewals];
        })
      );
      sendCsv(res, filename, ["Plan Name", "Total Members", "Active Members", "Expired Members", "Total Renewals"], rows);
      return;
    }

    const { start, end } = parseRange(req, 30);
    const filters = filterOptionsQuery(req);
    const paymentMatch = { gymId: req.gymId, date: { $gte: start, $lte: end } };
    if (filters.planId) paymentMatch.plan = new mongoose.Types.ObjectId(filters.planId);
    if (filters.paymentStatus) paymentMatch.status = filters.paymentStatus;
    if (filters.paymentMethod) paymentMatch.method = filters.paymentMethod;
    const paymentExtra = [];
    if (filters.branchCode) {
      paymentExtra.push(
        { $lookup: { from: "members", localField: "member", foreignField: "_id", as: "_member" } },
        { $unwind: "$_member" },
        ...(filters.branchCode ? [{ $match: { "_member.branchCode": filters.branchCode } }] : [])
      );
    }
    const [payments, totalMembers, activeMembers, attendanceCount] = await Promise.all([
      Payment.aggregate([
        ...paymentExtra,
        { $match: paymentMatch },
        { $lookup: { from: "plans", localField: "plan", foreignField: "_id", as: "plan" } },
        { $lookup: { from: "members", localField: "member", foreignField: "_id", as: "member" } },
        { $unwind: { path: "$plan", preserveNullAndEmptyArrays: true } },
        { $unwind: { path: "$member", preserveNullAndEmptyArrays: true } },
        { $lookup: { from: "users", localField: "member.user", foreignField: "_id", as: "memberUser" } },
        { $unwind: { path: "$memberUser", preserveNullAndEmptyArrays: true } },
      ]),
      Member.countDocuments({ gymId: req.gymId, ...(filters.branchCode ? { branchCode: filters.branchCode } : {}), ...(filters.memberStatus ? { status: filters.memberStatus } : {}), status: filters.memberStatus || { $in: ["active", "pending"] } }),
      Member.countDocuments({ gymId: req.gymId, ...(filters.branchCode ? { branchCode: filters.branchCode } : {}), ...(filters.memberStatus ? { status: filters.memberStatus } : {}), status: filters.memberStatus || { $in: ["active", "pending"] }, isActivePlan: true }),
      (async () => {
        const attMatch = { gymId: req.gymId, checkIn: { $gte: start, $lte: end }, deletedAt: null };
        const attExtra = [];
        if (filters.branchCode) {
          attExtra.push(
            { $lookup: { from: "members", localField: "member", foreignField: "_id", as: "_member" } },
            { $unwind: "$_member" },
          );
        }
        const attendanceRows = await Attendance.aggregate([
          ...attExtra,
          { $match: { ...attMatch, ...(filters.branchCode ? { "_member.branchCode": filters.branchCode } : {}) } },
          { $count: "count" },
        ]);
        return attendanceRows.length ? attendanceRows[0].count : 0;
      })(),
    ]);
    const overviewRows = [
      ["KPI", "Value"],
      ["Total Members", totalMembers],
      ["Active Members", activeMembers],
      ["Attendance Count", attendanceCount],
      ["Total Invoices", payments.length],
      ["Total Revenue (INR)", payments.reduce((a, b) => a + (b.amount || 0), 0)],
      [],
      ["Invoice #", "Date", "Member Name", "Member Email", "Member Phone", "Plan", "Amount", "Method", "Status"],
      ...payments.map(p => [
        p.invoiceNumber,
        format(new Date(p.date), "yyyy-MM-dd"),
        p.memberUser?.name || "",
        p.memberUser?.email || "",
        p.memberUser?.phone || "",
        p.plan?.name || "",
        p.amount,
        p.method,
        p.status,
      ]),
    ];
    sendCsv(res, filename, [], []);
    const lines = overviewRows.map(r => r.map(c => escCsv(c)).join(","));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}.csv"`);
    res.status(200).send("\uFEFF" + lines.join("\n"));
    return;
  }

  if (fmt === "pdf") {
    const { start, end } = parseRange(req, 30);
    const filters = filterOptionsQuery(req);
    const paymentMatch = { gymId: req.gymId, date: { $gte: start, $lte: end } };
    if (filters.planId) paymentMatch.plan = new mongoose.Types.ObjectId(filters.planId);
    if (filters.paymentStatus) paymentMatch.status = filters.paymentStatus;
    if (filters.paymentMethod) paymentMatch.method = filters.paymentMethod;

    const paymentExtra = [];
    if (filters.branchCode) {
      paymentExtra.push(
        { $lookup: { from: "members", localField: "member", foreignField: "_id", as: "_member" } },
        { $unwind: "$_member" },
      );
    }
    const scopedPaymentMatch = { ...paymentMatch, ...(filters.branchCode ? { "_member.branchCode": filters.branchCode } : {}) };

    const [revenue, members, attendance, paidCount, pendingCount, byPlan, byMethod] = await Promise.all([
      Payment.aggregate([...paymentExtra, { $match: scopedPaymentMatch }, { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } }]),
      Member.countDocuments({ gymId: req.gymId, ...(filters.branchCode ? { branchCode: filters.branchCode } : {}) }),
      (async () => {
        const attMatch = { gymId: req.gymId, checkIn: { $gte: start, $lte: end }, deletedAt: null };
        const attExtra = [];
        if (filters.branchCode) {
          attExtra.push(
            { $lookup: { from: "members", localField: "member", foreignField: "_id", as: "_member" } },
            { $unwind: "$_member" },
          );
        }
        const attRows = await Attendance.aggregate([
          ...attExtra,
          { $match: { ...attMatch, ...(filters.branchCode ? { "_member.branchCode": filters.branchCode } : {}) } },
          { $count: "count" },
        ]);
        return attRows.length ? attRows[0].count : 0;
      })(),
      Payment.aggregate([...paymentExtra, { $match: { ...scopedPaymentMatch, status: "paid" } }, { $count: "count" }]).then(r => r.length ? r[0].count : 0),
      Payment.aggregate([...paymentExtra, { $match: { ...scopedPaymentMatch, status: "pending" } }, { $count: "count" }]).then(r => r.length ? r[0].count : 0),
      Payment.aggregate([
        ...paymentExtra,
        { $match: scopedPaymentMatch },
        { $group: { _id: "$plan", total: { $sum: "$amount" } } },
        { $lookup: { from: "plans", localField: "_id", foreignField: "_id", as: "plan" } },
        { $project: { total: 1, name: { $arrayElemAt: ["$plan.name", 0] } } },
      ]),
      Payment.aggregate([...paymentExtra, { $match: scopedPaymentMatch }, { $group: { _id: "$method", total: { $sum: "$amount" } } }]),
    ]);

    const totalRevenue = revenue[0]?.total || 0;
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}.pdf"`);
    doc.pipe(res);

    doc.fontSize(20).fillColor("#6d28d9").text("A1 FITNESS", { align: "left" });
    doc.fontSize(10).fillColor("#475569").text("Analytics Report", { align: "left" });
    doc.moveDown(0.25);
    doc.fontSize(9).fillColor("#64748b").text(`Period: ${format(start, "yyyy-MM-dd")} — ${format(end, "yyyy-MM-dd")}`);
    doc.moveDown(0.5);
    doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke("#e2e8f0").stroke();
    doc.moveDown(0.5);

    doc.fontSize(14).fillColor("#0f172a").text("KPIs");
    doc.moveDown(0.3);
    const kpis = [
      ["Total Revenue", `${CURRENCY_SYMBOL}${totalRevenue.toLocaleString("en-IN")}`],
      ["Total Transactions", String(revenue[0]?.count || 0)],
      ["Paid Payments", String(paidCount)],
      ["Pending Payments", String(pendingCount)],
      ["Total Members", String(members)],
      ["Attendance", String(attendance)],
    ];
    const colW = 260;
    kpis.forEach((k, i) => {
      const x = 40 + (i % 2) * (colW + 20);
      const y = doc.y;
      doc.roundedRect(x, y, colW, 36, 8).fill("#f5f3ff").stroke("#ddd6fe");
      doc.fontSize(9).fillColor("#64748b").text(k[0], x + 12, y + 8);
      doc.fontSize(14).fillColor("#0f172a").text(k[1], x + 12, y + 20);
      if (i % 2 === 1 && i !== kpis.length - 1) doc.y += 52;
    });

    doc.moveDown(1.2);
    doc.fontSize(14).fillColor("#0f172a").text("Revenue By Plan");
    doc.moveDown(0.3);
    if (byPlan.length === 0) {
      doc.fontSize(10).fillColor("#64748b").text("No data for selected period.");
    } else {
      doc.fontSize(10).fillColor("#0f172a");
      byPlan.forEach(p => {
        doc.text(`• ${p.name || "No plan"}: ${CURRENCY_SYMBOL}${p.total.toLocaleString("en-IN")}`);
        doc.moveDown(0.1);
      });
    }

    doc.moveDown(0.5);
    doc.fontSize(14).fillColor("#0f172a").text("Revenue By Payment Method");
    doc.moveDown(0.3);
    if (byMethod.length === 0) {
      doc.fontSize(10).fillColor("#64748b").text("No data for selected period.");
    } else {
      doc.fontSize(10).fillColor("#0f172a");
      byMethod.forEach(m => {
        doc.text(`• ${(m._id || "unknown").toUpperCase()}: ${CURRENCY_SYMBOL}${m.total.toLocaleString("en-IN")}`);
        doc.moveDown(0.1);
      });
    }

    doc.moveDown(0.6);
    doc.fontSize(9).fillColor("#94a3b8").text("Generated by A1 Fitness — computer-generated report", { align: "center" });

    doc.end();
    return;
  }

  sendCsv(res, filename, ["Export"], [["Unsupported format"]]);
});

module.exports = {
  getReportOverview,
  getFilterOptions,
  getRevenueTable,
  getMembershipTable,
  exportReport,
};
