const mongoose = require("mongoose");

const attendanceSchema = new mongoose.Schema(
  {
    gymId: { type: String, required: true, index: true },
    member: { type: mongoose.Schema.Types.ObjectId, ref: "Member", required: true, index: true },
    date: { type: String, required: true, index: true },
    checkIn: { type: Date, default: null },
    checkOut: { type: Date, default: null },
    status: {
      type: String,
      enum: ["present", "completed", "absent", "late", "half-day"],
      default: "present",
      index: true
    },
    faceRecognitionMatched: { type: Boolean, default: null },
    source: {
      type: String,
      enum: ["app", "secret_code", "admin", "trainer", "scanner"],
      default: "app",
      index: true
    },
    scanner: { type: mongoose.Schema.Types.ObjectId, ref: "Scanner", default: null, index: true },
    eventType: { type: String, enum: ["fingerprint", "card", "pin", "face", null], default: null },
    deviceEventId: { type: String },
    notes: { type: String, trim: true, maxlength: 500 },
    timezone: { type: String, default: "Asia/Kolkata" },
    location: {
      checkIn: {
        latitude: Number,
        longitude: Number,
        accuracy: Number
      },
      checkOut: {
        latitude: Number,
        longitude: Number,
        accuracy: Number
      }
    },
    deletedAt: { type: Date, default: null },
    auditLogs: [{
      action: String,
      performedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      timestamp: { type: Date, default: Date.now },
      details: String,
      ipAddress: String
    }],
    branchCode: { type: String, default: "MAIN", index: true }
  },
  { timestamps: true }
);

attendanceSchema.index({ gymId: 1, member: 1, date: 1 }, { unique: true });
attendanceSchema.index({ member: 1, date: -1 });
attendanceSchema.index({ status: 1, date: 1 });
attendanceSchema.index({ deletedAt: 1 });
attendanceSchema.index({ deviceEventId: 1 }, { unique: true, partialFilterExpression: { deviceEventId: { $type: "string" } } });

attendanceSchema.methods.softDelete = function() {
  this.deletedAt = new Date();
  return this.save();
};

attendanceSchema.methods.addAuditLog = function(action, performedBy, details, ipAddress) {
  this.auditLogs.push({
    action,
    performedBy,
    timestamp: new Date(),
    details,
    ipAddress
  });
  return this.save();
};

attendanceSchema.statics.findByMemberAndDate = function(memberId, date) {
  return this.findOne({
    member: memberId,
    date: date,
    deletedAt: null
  });
};

attendanceSchema.statics.getMemberAttendanceStats = async function(memberId, startDate, endDate) {
  const records = await this.find({
    member: memberId,
    date: { $gte: startDate, $lte: endDate },
    deletedAt: null
  });

  const totalDays = records.length;
  const presentDays = records.filter(r => r.status === "present" || r.status === "completed").length;
  const completedDays = records.filter(r => r.status === "completed").length;
  const halfDays = records.filter(r => r.status === "half-day").length;
  const absentDays = records.filter(r => r.status === "absent").length;
  const lateDays = records.filter(r => r.status === "late").length;

  const checkInTimes = records
    .filter(r => r.checkIn)
    .map(r => new Date(r.checkIn).getHours() * 60 + new Date(r.checkIn).getMinutes());

  const avgCheckInMinutes = checkInTimes.length > 0
    ? Math.round(checkInTimes.reduce((a, b) => a + b, 0) / checkInTimes.length)
    : 0;
  const avgCheckInTime = `${String(Math.floor(avgCheckInMinutes / 60)).padStart(2, "0")}:${String(avgCheckInMinutes % 60).padStart(2, "0")}`;

  return {
    totalDays,
    presentDays,
    completedDays,
    halfDays,
    absentDays,
    lateDays,
    avgCheckInTime,
    attendanceRate: totalDays > 0 ? Math.round((presentDays / totalDays) * 100) : 0
  };
};

module.exports = mongoose.model("Attendance", attendanceSchema);