const Attendance = require("../models/attendance.model");
const Member = require("../models/member.model");
const ScannerEvent = require("../models/scannerEvent.model");
const { getMembershipEligibility } = require("../utils/membership");
const { formatDateInTimezone, DEFAULT_TIMEZONE } = require("../utils/date");
const { normalizeUserId } = require("../utils/admsParser");
const { emitToGym } = require("./realtime.service");
const { issueDoorAuthorization } = require("./doorAuthorization.service");

const LATE_THRESHOLD_HOUR = 9;
const MAX_FUTURE_EVENT_SKEW_MS = 5 * 60 * 1000;

const DEVICE_EVENT_ID = "deviceEventId";

function getHourInTimeZone(date, timezone = DEFAULT_TIMEZONE) {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hourCycle: "h23" }).format(date)
  );
}

function uniqueCandidates(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const cleaned = String(value === undefined || value === null ? "" : value).trim();
    if (!cleaned) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

async function resolveMember(gymId, event) {
  if (event.userId !== undefined && event.userId !== null && event.userId !== "") {
    const candidates = uniqueCandidates([
      normalizeUserId(event.userId),
      event.rawUserId,
      event.userId
    ]);
    for (const candidate of candidates) {
      const member = await Member.findOne({ gymId, "biometrics.deviceUserId": candidate });
      if (member) return member;
    }
  }
  if (event.cardId) {
    const candidates = uniqueCandidates([
      normalizeUserId(event.cardId),
      event.rawCardId,
      event.cardId
    ]);
    for (const candidate of candidates) {
      const member = await Member.findOne({ gymId, "biometrics.cardId": candidate });
      if (member) return member;
    }
  }
  return null;
}

async function createScannerEvent({ scanner, member, attendance, event, decision, reason, deviceEventId, timestamp, eventType }) {
  const doc = {
    gymId: scanner.gymId,
    branchCode: scanner.branchCode || "MAIN",
    scanner: scanner._id,
    deviceId: scanner.deviceId,
    member: member ? member._id : null,
    attendance: attendance ? attendance._id : null,
    eventType,
    decision,
    reason,
    deviceEventId,
    timestamp,
    raw: event || {}
  };

  try {
    return { created: true, doc: await ScannerEvent.create(doc) };
  } catch (err) {
    if (err && err.code === 11000) {
      const existing = await ScannerEvent.findOne({ [DEVICE_EVENT_ID]: deviceEventId });
      return { created: false, doc: existing || null };
    }
    throw err;
  }
}

async function logScannerEvent(input) {
  return createScannerEvent(input);
}

function emitAttendanceUpdate({ scanner, member, attendance, decision, reason, eventType }) {
  if (!attendance || !scanner) return;
  emitToGym(scanner.gymId, "ui:attendance_update", {
    type: "attendance",
    source: "scanner",
    attendanceId: attendance._id,
    memberId: member ? member._id : null,
    branchCode: scanner.branchCode || "MAIN",
    date: attendance.date,
    status: attendance.status,
    checkIn: attendance.checkIn instanceof Date ? attendance.checkIn.toISOString() : attendance.checkIn || null,
    checkOut: attendance.checkOut instanceof Date ? attendance.checkOut.toISOString() : attendance.checkOut || null,
    scanner: {
      _id: scanner._id,
      deviceId: scanner.deviceId,
      name: scanner.name || scanner.deviceId
    },
    eventType,
    decision,
    reason
  });
}

const push = (attendance, action, eventTime, member, scanner, eventType, deviceEventId) => {
  attendance.auditLogs.push({
    action,
    performedBy: member.user,
    timestamp: new Date(),
    details: `Scanner ${scanner.name || scanner.deviceId} ${action.replace("_", " ")}`,
    ipAddress: "scanner"
  });
  attendance.source = "scanner";
  attendance.scanner = scanner._id;
  attendance.eventType = eventType;
  attendance.deviceEventId = deviceEventId;
  attendance.membershipValidAtEvent = true;
  attendance.membershipValidatedAt = new Date();
  return attendance;
};

function consolidate(created) {
  if (created.created) return created.doc;
  return null;
}

async function issueAuthorizationSafely({ scanner, member, attendance, scannerEvent }) {
  try {
    return await issueDoorAuthorization({ scanner, member, attendance, scannerEvent });
  } catch (err) {
    const message = err && err.message ? err.message : "authorization persistence failed";
    if (scanner && typeof scanner.logError === "function") {
      const logResult = scanner.logError(`Door authorization not issued: ${message}`, "error");
      if (logResult && typeof logResult.catch === "function") await logResult.catch(() => {});
    }
    return null;
  }
}

async function processScannerEvent({ scanner, event }) {
  const gymId = scanner.gymId;
  const hasProvidedTimestamp = event.timestamp !== undefined && event.timestamp !== null && event.timestamp !== "";
  const parsedEventTime = hasProvidedTimestamp ? new Date(event.timestamp) : new Date();
  const timestampIsValid = parsedEventTime instanceof Date && !Number.isNaN(parsedEventTime.getTime());
  const eventTime = timestampIsValid ? parsedEventTime : new Date();
  const eventType = event.eventType || "fingerprint";
  const deviceEventId = event.deviceEventId || `${scanner.deviceId}:${eventTime.getTime()}`;
  const timezone = scanner.deviceTimezone || DEFAULT_TIMEZONE;
  const raw = event || {};

  const existingEvent = await ScannerEvent.findOne({ deviceEventId });
  if (existingEvent) return { status: "duplicate", id: existingEvent._id };

  if (!timestampIsValid || eventTime.getTime() - Date.now() > MAX_FUTURE_EVENT_SKEW_MS) {
    const created = await logScannerEvent({ scanner, event, eventType, decision: "deny", reason: "invalid_timestamp", deviceEventId, timestamp: eventTime });
    if (!consolidate(created)) return { status: "duplicate", id: null };
    return { status: "denied", reason: "invalid_timestamp", id: createScannerEventId(created) };
  }

  const verified = event.verified !== false && event.decision !== "deny";

  if (!verified) {
    const created = await logScannerEvent({ scanner, event, eventType, decision: "deny", reason: "not_matched", deviceEventId, timestamp: eventTime });
    if (!consolidate(created)) return { status: "duplicate", id: null };
    return { status: "denied", reason: "not_matched", id: createScannerEventId(created) };
  }

  const member = await resolveMember(gymId, event);
  if (!member) {
    const created = await logScannerEvent({ scanner, event, eventType, decision: "deny", reason: "unknown_user", deviceEventId, timestamp: eventTime });
    if (!consolidate(created)) return { status: "duplicate", id: null };
    return { status: "denied", reason: "unknown_user", id: createScannerEventId(created) };
  }

  const memberBranch = String(member.branchCode || "").trim().toLowerCase();
  const scannerBranch = String(scanner.branchCode || "").trim().toLowerCase();

  if (memberBranch !== scannerBranch) {
    const created = await logScannerEvent({ scanner, member, event, eventType, decision: "deny", reason: "branch_mismatch", deviceEventId, timestamp: eventTime });
    if (!consolidate(created)) return { status: "duplicate", id: null };
    return { status: "denied", reason: "branch_mismatch", id: createScannerEventId(created) };
  }

  const eligibility = await getMembershipEligibility(member, eventTime, { timezone });
  if (!eligibility.eligible) {
    const created = await logScannerEvent({ scanner, member, event, eventType, decision: "deny", reason: eligibility.reason, deviceEventId, timestamp: eventTime });
    if (!consolidate(created)) return { status: "duplicate", id: null };
    return { status: "denied", reason: eligibility.reason, id: createScannerEventId(created) };
  }

  const today = formatDateInTimezone(eventTime, timezone);
  const hour = getHourInTimeZone(eventTime, timezone);
  const isLate = hour >= LATE_THRESHOLD_HOUR;

  let attendance = await Attendance.findOne({ gymId, member: member._id, date: today, deletedAt: null });

  if (attendance && attendance.checkIn && attendance.checkOut) {
    const created = await logScannerEvent({ scanner, member, attendance, event, eventType, decision: "allow", reason: "duplicate", deviceEventId, timestamp: eventTime });
    return { status: "duplicate", id: createScannerEventId(created) };
  }

  if (attendance && attendance.checkIn && scanner.settings.enableCheckOutOnSecondScan !== false) {
    attendance.checkOut = new Date(eventTime);
    if (attendance.status === "present") attendance.status = "completed";
    push(attendance, "check-out", eventTime, member, scanner, eventType, deviceEventId);
    await attendance.save();
    const created = await logScannerEvent({ scanner, member, attendance, event, eventType, decision: "allow", reason: "checkout", deviceEventId, timestamp: eventTime });
    if (!consolidate(created)) return { status: "duplicate", id: null };
    const authorization = await issueAuthorizationSafely({ scanner, member, attendance, scannerEvent: created.doc });
    emitAttendanceUpdate({ scanner, member, attendance, decision: "allow", reason: "checkout", eventType });
    return { status: "checkout", id: createScannerEventId(created), authorization };
  }

  if (attendance && !attendance.checkIn) {
    attendance.checkIn = new Date(eventTime);
    attendance.status = isLate ? "late" : "present";
    push(attendance, "check-in", eventTime, member, scanner, eventType, deviceEventId);
    await attendance.save();
    const created = await logScannerEvent({ scanner, member, attendance, event, eventType, decision: "allow", reason: "verified", deviceEventId, timestamp: eventTime });
    if (!consolidate(created)) return { status: "duplicate", id: null };
    const authorization = await issueAuthorizationSafely({ scanner, member, attendance, scannerEvent: created.doc });
    emitAttendanceUpdate({ scanner, member, attendance, decision: "allow", reason: "verified", eventType });
    return { status: "checkin", id: createScannerEventId(created), authorization };
  }

  let newAttendance;
  try {
    newAttendance = await Attendance.create({
      gymId,
      branchCode: scanner.branchCode || "MAIN",
      member: member._id,
      date: today,
      checkIn: new Date(eventTime),
      status: isLate ? "late" : "present",
      source: "scanner",
      scanner: scanner._id,
      eventType,
      deviceEventId,
      timezone,
      membershipValidAtEvent: true,
      membershipValidatedAt: new Date(),
      auditLogs: [{
        action: "check-in",
        performedBy: member.user,
        timestamp: new Date(eventTime),
        details: `Scanner ${scanner.name || scanner.deviceId} check-in`,
        ipAddress: "scanner"
      }]
    });
  } catch (err) {
    if (err.code === 11000) {
      const created = await logScannerEvent({ scanner, member, event, eventType, decision: "deny", reason: "duplicate", deviceEventId, timestamp: eventTime });
      if (!consolidate(created)) return { status: "duplicate", id: null };
      return { status: "duplicate", id: createScannerEventId(created) };
    }
    throw err;
  }

  const created = await logScannerEvent({ scanner, member, attendance: newAttendance, event, eventType, decision: "allow", reason: "verified", deviceEventId, timestamp: eventTime });
  if (!consolidate(created)) return { status: "duplicate", id: null };
  const authorization = await issueAuthorizationSafely({ scanner, member, attendance: newAttendance, scannerEvent: created.doc });
  emitAttendanceUpdate({ scanner, member, attendance: newAttendance, decision: "allow", reason: "verified", eventType });
  return { status: "checkin", id: createScannerEventId(created), authorization };
}

function createScannerEventId(created) {
  return created && created.doc ? created.doc._id : null;
}

module.exports = { processScannerEvent, resolveMember };