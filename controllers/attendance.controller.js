const Attendance = require("../models/attendance.model");
const Member = require("../models/member.model");
const User = require("../models/user.model");
const { asyncHandler } = require("../utils/asyncHandler");
const { sendResponse } = require("../utils/response");
const { getPagination } = require("../utils/pagination");
const { AppError } = require("../utils/appError");
const { getTodayDate, formatDateInTimezone } = require("../utils/date");
const { assertMemberEligible } = require("../utils/membership");
const { getCache, setCache } = require("../services/cache.service");

const GRACE_PERIOD_MINUTES = 15;
const LATE_THRESHOLD_HOUR = 9;

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth radius in meters
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function validateGeofence(latitude, longitude) {
  const gymLat = parseFloat(process.env.GYM_LATITUDE);
  const gymLon = parseFloat(process.env.GYM_LONGITUDE);
  const radius = parseFloat(process.env.GYM_LOCATION_RADIUS_METERS) || 100;

  console.log(`[Geofence Debug] Member Loc: ${latitude}, ${longitude} | Gym Loc: ${gymLat}, ${gymLon} | Allowed Radius: ${radius}m`);

  if (!latitude || !longitude) {
    return { valid: false, distance: null, message: "Location access is required for check-in. Please enable location services." };
  }

  if (!gymLat || !gymLon || gymLat === 0 || gymLon === 0) {
    console.error("[GEOFENCE CONFIG ERROR] Gym location is not properly configured! Set GYM_LATITUDE and GYM_LONGITUDE in environment variables.");
    return { valid: false, distance: null, message: "Gym location is not configured. Please contact the administrator." };
  }

  const distance = calculateDistance(latitude, longitude, gymLat, gymLon);
  console.log(`[Geofence Debug] Calculated Distance: ${Math.round(distance)}m`);

  if (distance > radius) {
    return {
      valid: false,
      distance: Math.round(distance),
      message: `You are ${Math.round(distance)}m away from the gym (Your location: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}). Check-in is only allowed within ${radius}m.`
    };
  }
  return { valid: true, distance: Math.round(distance), message: "Within gym radius" };
}

/**
 * @desc    Mark attendance (check-in or check-out)
 * @route   POST /api/attendance/mark
 * @access  Public (Secret Code) OR Private (Admin/Trainer with memberId)
 */
const markAttendance = asyncHandler(async (req, res) => {
  const { secretCode, memberId, action, location, branchCode: requestedBranchCode } = req.body;
  const isAdminOrTrainer = req.user && ["admin", "superadmin", "trainer"].includes(req.user.role);

  let member;
  if (isAdminOrTrainer && memberId) {
    member = await Member.findOne({ _id: memberId, gymId: req.gymId }).populate("user");
    if (!member) throw new AppError("Member not found", 404);
    if (req.user.role !== "superadmin") {
      const userBranch = (req.user.branchCode || "MAIN").trim().toUpperCase();
      const memBranch = (member.branchCode || "MAIN").trim().toUpperCase();
      if (userBranch !== memBranch) {
        throw new AppError("Member not found in your branch", 404);
      }
      // Trainer isolation: trainers may only mark attendance for their assigned members.
      if (req.user.role === "trainer") {
        if (!member.trainer || String(member.trainer) !== String(req.user._id)) {
          throw new AppError("You can only mark attendance for members assigned to you", 403);
        }
      }
    } else if (requestedBranchCode) {
      const validatedBranch = requestedBranchCode.trim().toUpperCase();
      const memBranch = (member.branchCode || "MAIN").trim().toUpperCase();
      if (validatedBranch !== memBranch) {
        throw new AppError("Member does not belong to the selected branch", 400);
      }
    }
  } else {
    if (!secretCode) throw new AppError("Secret code is required for self check-in", 400);
    member = await Member.findOne({ secretCode }).populate("user");
    if (!member) throw new AppError("Invalid secret code", 404);

    // Enforce geofencing for self check-in (Secret Code/QR)
    const { latitude, longitude, accuracy } = location || {};
    const geoValidation = validateGeofence(latitude, longitude);
    if (!geoValidation.valid) {
      console.log(`[Geofence Rejected] Member: ${member.user.name} (Secret Code) attempted ${action} from ${geoValidation.distance}m away.`);
      throw new AppError(geoValidation.message, 400);
    }
  }

  assertMemberEligible(member);

  const today = getTodayDate();
  const gymId = member.gymId;
  const branchCode = member.branchCode || "MAIN";

  let attendance = await Attendance.findOne({ member: member._id, date: today, deletedAt: null });

  if (!attendance) {
    if (action === "check-out") {
      throw new AppError("You haven't checked in yet today.", 400);
    }

    const serverTime = new Date();
    const checkInHour = serverTime.getHours();
    const isLate = checkInHour >= LATE_THRESHOLD_HOUR;

    attendance = await Attendance.create({
      gymId,
      branchCode,
      member: member._id,
      date: today,
      checkIn: serverTime,
      status: isLate ? "late" : "present",
      location: location ? { checkIn: location } : undefined,
      auditLogs: isAdminOrTrainer ? [{
        action: "manual_checkin",
        performedBy: req.user._id,
        timestamp: new Date(),
        details: "Manual check-in by admin/trainer",
        ipAddress: req.ip
      }] : [{
        action: "check-in",
        performedBy: member.user._id,
        timestamp: serverTime,
        details: "Self check-in via secret code",
        ipAddress: req.ip
      }]
    });

    await Attendance.cacheAttendanceStatus(gymId, member._id.toString(), attendance);

    if (req.app.locals.io) {
      req.app.locals.io.to(gymId).emit("attendance:update", {
        type: "check-in",
        member: member.user.name,
        time: attendance.checkIn,
        status: attendance.status
      });
    }

    return sendResponse(res, {
      status: 201,
      message: `Welcome, ${member.user.name}! ${isLate ? "You are marked as late. " : ""}Checked in successfully.`,
      data: attendance
    });
  }

  if (attendance.status === "present" || attendance.status === "late") {
    if (action === "check-in") {
      throw new AppError("You are already checked in.", 400);
    }

    attendance.checkOut = new Date();
    if (location) {
      attendance.location = { ...attendance.location, checkOut: location };
    }

    // Only change status to "completed" if currently "present" (on-time)
    // Preserve "late" status if member checked in late
    if (attendance.status === "present") {
      attendance.status = "completed";
    }
    if (isAdminOrTrainer) {
      attendance.auditLogs.push({
        action: "manual_checkout",
        performedBy: req.user._id,
        timestamp: new Date(),
        details: "Manual check-out by admin/trainer",
        ipAddress: req.ip
      });
    } else {
      attendance.auditLogs.push({
        action: "check-out",
        performedBy: member.user._id,
        timestamp: new Date(),
        details: "Self check-out via secret code",
        ipAddress: req.ip
      });
    }
    await attendance.save();

    await Attendance.cacheAttendanceStatus(gymId, member._id.toString(), attendance);

    if (req.app.locals.io) {
      req.app.locals.io.to(gymId).emit("attendance:update", {
        type: "check-out",
        member: member.user.name,
        time: attendance.checkOut
      });
    }

    return sendResponse(res, {
      message: `Goodbye, ${member.user.name}! Checked out successfully.`,
      data: attendance
    });
  }

  throw new AppError("Attendance already completed for today", 400);
});

const memberCheckIn = asyncHandler(async (req, res) => {
  if (req.user.role !== "member") {
    throw new AppError("Only members can perform self check-in", 403);
  }

  const member = await Member.findOne({ user: req.user._id, gymId: req.gymId });
  if (!member) throw new AppError("Member profile not found", 404);

  assertMemberEligible(member);

  const cacheKey = `attendance:today:${req.gymId}:${member._id}`;
  const cachedStatus = await getCache(cacheKey);

  if (cachedStatus && cachedStatus.status !== "absent") {
    throw new AppError(`You have already ${cachedStatus.checkOut ? "completed" : "checked in"} attendance today`, 400);
  }

  const today = getTodayDate();
  const existing = await Attendance.findOne({ member: member._id, date: today, deletedAt: null });
  if (existing) {
    throw new AppError("Attendance already exists for today", 400);
  }

  const { latitude, longitude, accuracy } = req.body.location || {};
  const serverTime = new Date();
  const checkInHour = serverTime.getHours();
  const isLate = checkInHour >= LATE_THRESHOLD_HOUR;

  // Geofence disabled for Member self check-in (current phase).
  // To re-enable in a future feature, restore this validation:
  // const geoValidation = validateGeofence(latitude, longitude);
  // if (!geoValidation.valid) {
  //   console.log(`[Geofence Rejected] Member: ${req.user.name} attempted check-in from ${geoValidation.distance}m away.`);
  //   throw new AppError(geoValidation.message, 400);
  // }

  const attendance = await Attendance.create({
    gymId: req.gymId,
    branchCode: member.branchCode || "MAIN",
    member: member._id,
    date: today,
    checkIn: serverTime,
    status: isLate ? "late" : "present",
    location: {
      checkIn: { latitude, longitude, accuracy }
    },
    timezone: req.body.timezone || "Asia/Kolkata",
    auditLogs: [{
      action: "check-in",
      performedBy: req.user._id,
      timestamp: serverTime,
      ipAddress: req.ip
    }]
  });

  await Attendance.cacheAttendanceStatus(req.gymId, member._id.toString(), attendance);

  if (req.app.locals.io) {
    req.app.locals.io.to(req.gymId).emit("attendance:checkin", {
      memberId: member._id,
      memberName: req.user.name,
      time: attendance.checkIn,
      status: attendance.status
    });
  }

  sendResponse(res, {
    status: 201,
    message: isLate
      ? "Checked in successfully. You are marked as late due to arriving after 9:00 AM."
      : "Checked in successfully!",
    data: attendance
  });
});

const memberCheckOut = asyncHandler(async (req, res) => {
  if (req.user.role !== "member") {
    throw new AppError("Only members can perform self check-out", 403);
  }

  const member = await Member.findOne({ user: req.user._id, gymId: req.gymId });
  if (!member) throw new AppError("Member profile not found", 404);

  assertMemberEligible(member);

  const today = getTodayDate();
  const attendance = await Attendance.findOne({ member: member._id, date: today, deletedAt: null });

  if (!attendance) {
    throw new AppError("You haven't checked in today", 400);
  }

  if (attendance.checkOut) {
    throw new AppError("You have already checked out today", 400);
  }

  const { latitude, longitude, accuracy } = req.body.location || {};

  const geoValidation = validateGeofence(latitude, longitude);
  if (!geoValidation.valid) {
    console.log(`[Geofence Rejected] Member: ${req.user.name} attempted check-out from ${geoValidation.distance}m away.`);
    throw new AppError(geoValidation.message, 400);
  }

  attendance.checkOut = new Date();
  // Only change status to "completed" if currently "present" (on-time)
  // Preserve "late" status if member checked in late
  if (attendance.status === "present") {
    attendance.status = "completed";
  }
  attendance.location.checkOut = { latitude, longitude, accuracy };
  attendance.auditLogs.push({
    action: "check-out",
    performedBy: req.user._id,
    timestamp: new Date(),
    ipAddress: req.ip
  });
  await attendance.save();

  await Attendance.cacheAttendanceStatus(req.gymId, member._id.toString(), attendance);

  if (req.app.locals.io) {
    req.app.locals.io.to(req.gymId).emit("attendance:checkout", {
      memberId: member._id,
      memberName: req.user.name,
      time: attendance.checkOut
    });
  }

  sendResponse(res, {
    message: "Checked out successfully!",
    data: attendance
  });
});

const getMyAttendance = asyncHandler(async (req, res) => {
  if (req.user.role !== "member") {
    throw new AppError("Only members can access their own attendance", 403);
  }

  const member = await Member.findOne({ user: req.user._id, gymId: req.gymId });
  if (!member) throw new AppError("Member profile not found", 404);

  const { skip, limit, page } = getPagination(req.query);
  const { startDate, endDate, status, search } = req.query;

  const query = { gymId: req.gymId, member: member._id, deletedAt: null };

  if (startDate || endDate) {
    query.date = {};
    if (startDate) query.date.$gte = startDate;
    if (endDate) query.date.$lte = endDate;
  }

  if (status && status !== "all") {
    query.status = status;
  }

  const [items, total] = await Promise.all([
    Attendance.find(query)
      .sort({ date: -1, checkIn: -1 })
      .skip(skip)
      .limit(limit)
      .select("-auditLogs"),
    Attendance.countDocuments(query)
  ]);

  sendResponse(res, {
    message: "Your attendance history fetched",
    data: { items, page, limit, total }
  });
});

const getTodayStatus = asyncHandler(async (req, res) => {
  if (req.user.role !== "member") {
    throw new AppError("Only members can access their own attendance status", 403);
  }

  const member = await Member.findOne({ user: req.user._id, gymId: req.gymId });
  if (!member) throw new AppError("Member profile not found", 404);

  const cacheKey = `attendance:today:${req.gymId}:${member._id}`;
  const cached = await getCache(cacheKey);

  if (cached) {
    return sendResponse(res, {
      message: "Today's attendance status (cached)",
      data: cached
    });
  }

  const today = getTodayDate();
  const attendance = await Attendance.findOne({ member: member._id, date: today, deletedAt: null });

  if (attendance) {
    await Attendance.cacheAttendanceStatus(req.gymId, member._id.toString(), attendance);
  }

  sendResponse(res, {
    message: "Today's attendance status",
    data: attendance || { status: "absent", date: today }
  });
});

const ATTENDED_STATUSES = ["present", "completed", "late", "half-day"];

const calculateWorkoutStats = async (memberId, startDate, endDate) => {
  const monthRecords = await Attendance.find({
    member: memberId,
    date: { $gte: startDate, $lte: endDate },
    deletedAt: null
  });

  const totalRecords = monthRecords.length;
  const sessions = monthRecords.filter(r => ATTENDED_STATUSES.includes(r.status)).length;
  const sessionRate = totalRecords > 0 ? Math.round((sessions / totalRecords) * 100) : 0;

  let durationSum = 0;
  let durationCount = 0;
  for (const r of monthRecords) {
    if (r.checkIn && r.checkOut) {
      const ms = new Date(r.checkOut) - new Date(r.checkIn);
      if (ms > 0) {
        durationSum += ms;
        durationCount++;
      }
    }
  }
  const avgSessionMinutes = durationCount > 0 ? Math.round(durationSum / durationCount / 60000) : null;

  const attendedDates = new Set(
    (await Attendance.find({
      member: memberId,
      deletedAt: null,
      status: { $in: ATTENDED_STATUSES }
    }).select("date")).map(r => r.date)
  );

  let streak = 0;
  if (attendedDates.size > 0) {
    const cursor = new Date();
    cursor.setHours(0, 0, 0, 0);
    const todayStr = formatDateInTimezone(cursor);
    if (!attendedDates.has(todayStr)) cursor.setDate(cursor.getDate() - 1);

    for (let i = 0; i < 366; i++) {
      const dayStr = formatDateInTimezone(cursor);
      if (attendedDates.has(dayStr)) {
        streak++;
        cursor.setDate(cursor.getDate() - 1);
      } else {
        break;
      }
    }
  }

  return { sessions, sessionRate, sessionStreak: streak, avgSessionMinutes, totalRecords };
};

const getMyStats = asyncHandler(async (req, res) => {
  if (req.user.role !== "member") {
    throw new AppError("Only members can access their own attendance stats", 403);
  }

  const member = await Member.findOne({ user: req.user._id, gymId: req.gymId });
  if (!member) throw new AppError("Member profile not found", 404);

  const { month, year } = req.query;
  const now = new Date();
  const targetMonth = month ? parseInt(month) : now.getMonth() + 1;
  const targetYear = year ? parseInt(year) : now.getFullYear();

  const startDate = `${targetYear}-${String(targetMonth).padStart(2, "0")}-01`;
  const endDate = formatDateInTimezone(new Date(targetYear, targetMonth, 0));

  const stats = await Attendance.getMemberAttendanceStats(member._id, startDate, endDate);

  const currentStreak = await calculateCurrentStreak(member._id);
  const longestStreak = await calculateLongestStreak(member._id);

  const workoutStats = await calculateWorkoutStats(member._id, startDate, endDate);

  const dailyBreakdown = await getDailyBreakdown(member._id, startDate, endDate);

  sendResponse(res, {
    message: "Attendance statistics fetched",
    data: {
      ...stats,
      currentStreak,
      longestStreak,
      dailyBreakdown,
      sessions: workoutStats.sessions,
      sessionRate: workoutStats.sessionRate,
      sessionStreak: workoutStats.sessionStreak,
      avgSessionMinutes: workoutStats.avgSessionMinutes,
      month: targetMonth,
      year: targetYear
    }
  });
});

const getDailyBreakdown = async (memberId, startDate, endDate) => {
  const records = await Attendance.find({
    member: memberId,
    date: { $gte: startDate, $lte: endDate },
    deletedAt: null
  }).sort({ date: 1 });

  const breakdown = {
    labels: [],
    present: [],
    late: [],
    halfDay: [],
    absent: []
  };

  const start = new Date(startDate);
  const end = new Date(endDate);

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = formatDateInTimezone(d);
    const dayName = d.toLocaleDateString("en-US", { weekday: "short" });
    const record = records.find(r => r.date === dateStr);

    breakdown.labels.push(dayName);
    breakdown.present.push(record && (record.status === "present" || record.status === "completed") ? 1 : 0);
    breakdown.late.push(record && record.status === "late" ? 1 : 0);
    breakdown.halfDay.push(record && record.status === "half-day" ? 1 : 0);
    breakdown.absent.push(!record || record.status === "absent" ? 1 : 0);
  }

  return breakdown;
};

const calculateCurrentStreak = async (memberId) => {
  const records = await Attendance.find({
    member: memberId,
    deletedAt: null
  })
  .sort({ date: -1 })
  .limit(365);

  if (!records.length) return 0;

  let streak = 0;
  let currentDate = new Date();
  currentDate.setHours(0, 0, 0, 0);

  for (const record of records) {
    const recordDate = new Date(record.date);
    recordDate.setHours(0, 0, 0, 0);
    const diffDays = Math.floor((currentDate - recordDate) / (1000 * 60 * 60 * 24));

    if (diffDays <= 1 && (record.status === "present" || record.status === "completed")) {
      streak++;
      currentDate = recordDate;
    } else if (diffDays > 1) {
      break;
    }
  }
  return streak;
};

const calculateLongestStreak = async (memberId) => {
  const records = await Attendance.find({
    member: memberId,
    deletedAt: null
  }).sort({ date: 1 });

  if (!records.length) return 0;

  const sortedDates = [...new Set(records.map(r => r.date))].sort();
  let maxStreak = 1;
  let currentStreak = 1;

  for (let i = 1; i < sortedDates.length; i++) {
    const prev = new Date(sortedDates[i - 1]);
    const curr = new Date(sortedDates[i]);
    const diffDays = Math.floor((curr - prev) / (1000 * 60 * 60 * 24));

    if (diffDays === 1) {
      currentStreak++;
      maxStreak = Math.max(maxStreak, currentStreak);
    } else {
      currentStreak = 1;
    }
  }
  return maxStreak;
};

const exportMyAttendance = asyncHandler(async (req, res) => {
  if (req.user.role !== "member") {
    throw new AppError("Only members can export their attendance", 403);
  }

  const member = await Member.findOne({ user: req.user._id, gymId: req.gymId });
  if (!member) throw new AppError("Member profile not found", 404);

  const { format = "csv", startDate, endDate } = req.query;

  const query = { member: member._id, gymId: req.gymId, deletedAt: null };
  if (startDate || endDate) {
    query.date = {};
    if (startDate) query.date.$gte = startDate;
    if (endDate) query.date.$lte = endDate;
  }

  const records = await Attendance.find(query).sort({ date: -1 });

  const userData = await User.findById(req.user._id).select("name email");

  if (format === "csv") {
    const headers = ["Date", "Day", "Check-In Time", "Check-Out Time", "Duration (hours)", "Status", "Notes"];
    const rows = records.map(r => {
      const d = new Date(r.date);
      const dayName = d.toLocaleDateString("en-US", { weekday: "long" });
      const checkInTime = r.checkIn ? new Date(r.checkIn).toLocaleTimeString("en-IN", { timeZone: r.timezone }) : "";
      const checkOutTime = r.checkOut ? new Date(r.checkOut).toLocaleTimeString("en-IN", { timeZone: r.timezone }) : "";
      const duration = r.checkIn && r.checkOut
        ? ((new Date(r.checkOut) - new Date(r.checkIn)) / (1000 * 60 * 60)).toFixed(1)
        : "";

      return [
        r.date,
        dayName,
        checkInTime,
        checkOutTime,
        duration,
        r.status,
        r.notes || ""
      ];
    });

    const csv = [
      `Member Name,${userData.name}`,
      `Member ID,${member.secretCode || member._id}`,
      `Email,${userData.email}`,
      `Export Date,${formatDateInTimezone(new Date())}`,
      "",
      headers.join(","),
      ...rows.map(r => r.map(c => `"${c}"`).join(","))
    ].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="attendance_${member.secretCode || member._id}_${formatDateInTimezone(new Date())}.csv"`);
    return res.send(csv);
  }

  if (format === "pdf") {
    const stats = await Attendance.getMemberAttendanceStats(member._id, startDate || "1970-01-01", endDate || "2099-12-31");

    const html = generatePDFHtml(userData, member, records, stats, startDate, endDate);
    res.setHeader("Content-Type", "text/html");
    return res.send(html);
  }

  throw new AppError("Unsupported export format. Use 'csv' or 'pdf'.", 400);
});

const generatePDFHtml = (userData, member, records, stats, startDate, endDate) => {
  const rowsHtml = records.map(r => {
    const checkInTime = r.checkIn ? new Date(r.checkIn).toLocaleTimeString("en-IN", { timeZone: r.timezone }) : "-";
    const checkOutTime = r.checkOut ? new Date(r.checkOut).toLocaleTimeString("en-IN", { timeZone: r.timezone }) : "-";

    return `
      <tr>
        <td>${r.date}</td>
        <td>${checkInTime}</td>
        <td>${checkOutTime}</td>
        <td><span class="status ${r.status}">${r.status}</span></td>
        <td>${r.notes || "-"}</td>
      </tr>
    `;
  }).join("");

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Attendance Report - ${userData.name}</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 40px; color: #333; }
        h1 { color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 10px; }
        .header { margin-bottom: 30px; }
        .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin-bottom: 30px; }
        .stat-box { background: #f8f9fa; padding: 15px; border-radius: 8px; text-align: center; }
        .stat-value { font-size: 24px; font-weight: bold; color: #2c3e50; }
        .stat-label { font-size: 12px; color: #7f8c8d; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th { background: #3498db; color: white; padding: 12px; text-align: left; }
        td { padding: 10px; border-bottom: 1px solid #ddd; }
        tr:hover { background: #f8f9fa; }
        .status.present { color: #27ae60; }
        .status.completed { color: #2ecc71; }
        .status.late { color: #f39c12; }
        .status.half-day { color: #9b59b6; }
        .status.absent { color: #e74c3c; }
        .footer { margin-top: 30px; text-align: center; font-size: 12px; color: #7f8c8d; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>Attendance Report</h1>
        <p><strong>Member:</strong> ${userData.name}</p>
        <p><strong>Member ID:</strong> ${member.secretCode || member._id}</p>
        <p><strong>Email:</strong> ${userData.email}</p>
        <p><strong>Period:</strong> ${startDate || "All"} to ${endDate || "All"}</p>
        <p><strong>Generated:</strong> ${new Date().toLocaleString()}</p>
      </div>

      <div class="stats-grid">
        <div class="stat-box">
          <div class="stat-value">${stats.presentDays}</div>
          <div class="stat-label">Present Days</div>
        </div>
        <div class="stat-box">
          <div class="stat-value">${stats.lateDays}</div>
          <div class="stat-label">Late Days</div>
        </div>
        <div class="stat-box">
          <div class="stat-value">${stats.halfDays}</div>
          <div class="stat-label">Half Days</div>
        </div>
        <div class="stat-box">
          <div class="stat-value">${stats.attendanceRate}%</div>
          <div class="stat-label">Attendance Rate</div>
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Check-In</th>
            <th>Check-Out</th>
            <th>Status</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml || "<tr><td colspan='5' style='text-align:center;'>No records found</td></tr>"}
        </tbody>
      </table>

      <div class="footer">
        <p>This is a computer-generated report. No signature required.</p>
      </div>
    </body>
    </html>
  `;
};

/**
 * @desc    Get attendance history (paginated, searchable)
 * @route   GET /api/attendance
 * @access  Private (Admin/Trainer)
 */
const history = asyncHandler(async (req, res) => {
  const { skip, limit, page } = getPagination(req.query);
  const { search, date } = req.query;

  const query = { gymId: req.gymId, deletedAt: null };
  if (date) query.date = date;
  const scopeConditions = [];

  const requestedBranch = req.user && req.user.role !== "superadmin"
    ? (req.user.branchCode || "MAIN").trim().toUpperCase()
    : (req.query.branchCode && req.query.branchCode !== "ALL" && req.query.branchCode !== "all" ? req.query.branchCode.trim().toUpperCase() : undefined);

  if (requestedBranch) {
    // Attendance records are always member-linked. Scope by the member's CURRENT
    // branch (not the stored historical branchCode) so a member reassigned to
    // another branch has their attendance follow them instead of leaking into
    // the old branch's history.
    const memberQuery = { gymId: req.gymId, branchCode: requestedBranch };
    // Trainer isolation: trainers only see attendance for their assigned members.
    if (req.user && req.user.role === "trainer") {
      memberQuery.trainer = req.user._id;
    }
    const branchMemberIds = await Member.find(memberQuery).distinct("_id");
    scopeConditions.push({ member: { $in: branchMemberIds } });
  }

  if (search) {
    const members = await Member.aggregate([
      { $lookup: { from: "users", localField: "user", foreignField: "_id", as: "userDoc" } },
      { $unwind: "$userDoc" },
      { $match: { "userDoc.name": new RegExp(search, "i") } }
    ]);
    const searchMemberIds = members.map(m => m._id);
    scopeConditions.push({ member: { $in: searchMemberIds } });
  }

  if (scopeConditions.length > 0) {
    query.$and = query.$and ? [...query.$and, ...scopeConditions] : scopeConditions;
  }

  const [items, total] = await Promise.all([
    Attendance.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate({
        path: "member",
        populate: { path: "user", select: "name email phone" }
      }),
    Attendance.countDocuments(query)
  ]);

  sendResponse(res, { message: "Attendance history fetched", data: { items, page, limit, total } });
});

const checkIn = asyncHandler(async (req, res) => {
  const member = await Member.findOne({ _id: req.body.member, gymId: req.gymId });
  if (!member) throw new AppError("Member not found", 404);

  assertMemberEligible(member);

  if (req.user && req.user.role !== "superadmin") {
    const userBranch = (req.user.branchCode || "MAIN").trim().toUpperCase();
    const memBranch = (member.branchCode || "MAIN").trim().toUpperCase();
    if (userBranch !== memBranch) {
      throw new AppError("Member not found in your branch", 404);
    }
    // Trainer isolation: trainers may only check-in their assigned members.
    if (req.user.role === "trainer") {
      if (!member.trainer || String(member.trainer) !== String(req.user._id)) {
        throw new AppError("You can only check-in members assigned to you", 403);
      }
    }
  } else if (req.user && req.user.role === "superadmin" && req.body.branchCode) {
    const validatedBranch = req.body.branchCode.trim().toUpperCase();
    const memBranch = (member.branchCode || "MAIN").trim().toUpperCase();
    if (validatedBranch !== memBranch) {
      throw new AppError("Member does not belong to the selected branch", 400);
    }
  }

  const today = getTodayDate();
  const entry = await Attendance.create({
    gymId: req.gymId,
    branchCode: member.branchCode || "MAIN",
    member: req.body.member,
    date: today,
    faceRecognitionMatched: req.body.faceRecognitionMatched ?? null
  });
  if (req.app.locals.io) req.app.locals.io.to(req.gymId).emit("attendance:checkin", entry);
  sendResponse(res, { status: 201, message: "Checked in", data: entry });
});

const checkOut = asyncHandler(async (req, res) => {
  const entry = await Attendance.findOne({
    _id: req.params.id,
    gymId: req.gymId,
    deletedAt: null
  }).populate("member");
  if (!entry) throw new AppError("Attendance record not found", 404);

  if (req.user && req.user.role !== "superadmin") {
    const userBranch = (req.user.branchCode || "MAIN").trim().toUpperCase();
    const attBranch = (entry.branchCode || entry.member?.branchCode || "MAIN").trim().toUpperCase();
    if (userBranch !== attBranch) {
      throw new AppError("Attendance record not found in your branch", 404);
    }
    // Trainer isolation: trainers may only check-out their assigned members.
    if (req.user.role === "trainer") {
      const member = entry.member;
      if (!member || !member.trainer || String(member.trainer) !== String(req.user._id)) {
        throw new AppError("You can only check-out members assigned to you", 403);
      }
    }
  }

  entry.checkOut = new Date();
  entry.status = "completed";
  await entry.save();

  if (req.app.locals.io) req.app.locals.io.to(req.gymId).emit("attendance:checkout", entry);
  sendResponse(res, { message: "Checked out", data: entry });
});

const faceVerifyPlaceholder = asyncHandler(async (req, res) => {
  const { member, imageRef } = req.body;
  sendResponse(res, {
    message: "Face recognition placeholder result",
    data: {
      member,
      imageRef: imageRef || null,
      matched: true,
      confidence: 0.88,
      provider: "placeholder"
    }
  });
});

const getRealTimeStatus = asyncHandler(async (req, res) => {
  if (req.user.role !== "member") {
    throw new AppError("Only members can check real-time attendance status", 403);
  }

  const member = await Member.findOne({ user: req.user._id, gymId: req.gymId });
  if (!member) throw new AppError("Member profile not found", 404);

  const cacheKey = `attendance:today:${req.gymId}:${member._id}`;
  const cached = await getCache(cacheKey);

  if (cached) {
    return sendResponse(res, {
      message: "Real-time attendance status (cached)",
      data: { ...cached, cached: true }
    });
  }

  const today = getTodayDate();
  const attendance = await Attendance.findOne({ member: member._id, date: today, deletedAt: null });

  const status = {
    hasCheckedIn: !!attendance,
    hasCheckedOut: !!attendance?.checkOut,
    status: attendance?.status || "absent",
    checkIn: attendance?.checkIn,
    checkOut: attendance?.checkOut,
    date: today,
    cached: false
  };

  await setCache(cacheKey, status, 30);

  sendResponse(res, { message: "Real-time attendance status", data: status });
});

Attendance.cacheAttendanceStatus = async function(gymId, memberId, attendance) {
  const cacheKey = `attendance:today:${gymId}:${memberId}`;
  const status = {
    hasCheckedIn: true,
    hasCheckedOut: !!attendance.checkOut,
    status: attendance.status,
    checkIn: attendance.checkIn,
    checkOut: attendance.checkOut,
    date: attendance.date
  };
  await setCache(cacheKey, status, 86400);
};

const updateAttendance = asyncHandler(async (req, res) => {
  if (!["admin", "superadmin"].includes(req.user.role)) {
    throw new AppError("Only admins can update attendance records", 403);
  }

  const attendance = await Attendance.findOne({
    _id: req.params.id,
    gymId: req.gymId,
    deletedAt: null
  }).populate("member");

  if (!attendance) throw new AppError("Attendance record not found", 404);

  if (req.user.role !== "superadmin") {
    const userBranch = (req.user.branchCode || "MAIN").trim().toUpperCase();
    const attBranch = (attendance.branchCode || attendance.member?.branchCode || "MAIN").trim().toUpperCase();
    if (userBranch !== attBranch) {
      throw new AppError("Attendance record not found in your branch", 404);
    }
  }

  const { status, notes, checkIn, checkOut } = req.body;

  if (status) attendance.status = status;
  if (notes !== undefined) attendance.notes = notes;
  if (checkIn) attendance.checkIn = new Date(checkIn);
  if (checkOut) attendance.checkOut = new Date(checkOut);

  attendance.auditLogs.push({
    action: "update",
    performedBy: req.user._id,
    timestamp: new Date(),
    details: `Updated by admin: ${Object.keys(req.body).join(", ")}`,
    ipAddress: req.ip
  });

  await attendance.save();

  sendResponse(res, { message: "Attendance updated successfully", data: attendance });
});

const deleteAttendance = asyncHandler(async (req, res) => {
  if (!["admin", "superadmin"].includes(req.user.role)) {
    throw new AppError("Only admins can delete attendance records", 403);
  }

  const attendance = await Attendance.findOne({
    _id: req.params.id,
    gymId: req.gymId,
    deletedAt: null
  }).populate("member");

  if (!attendance) throw new AppError("Attendance record not found", 404);

  if (req.user.role !== "superadmin") {
    const userBranch = (req.user.branchCode || "MAIN").trim().toUpperCase();
    const attBranch = (attendance.branchCode || attendance.member?.branchCode || "MAIN").trim().toUpperCase();
    if (userBranch !== attBranch) {
      throw new AppError("Attendance record not found in your branch", 404);
    }
  }

  attendance.auditLogs.push({
    action: "delete",
    performedBy: req.user._id,
    timestamp: new Date(),
    ipAddress: req.ip
  });

  await attendance.softDelete();

  sendResponse(res, { message: "Attendance record deleted (soft delete)", data: null });
});

module.exports = {
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
};