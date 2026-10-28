const { test, before, after, beforeEach, describe } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const ROOT = path.join(__dirname, "..");

let scannerDocs = [];
let memberDocs = [];
let planDocs = [];
let attendanceStore = [];
let scannerEventStore = [];
let doorAuthorizationStore = [];

const FAKE_ID = { counter: 0 };
const nextId = (prefix) => `${prefix}_${++FAKE_ID.counter}`;

let emitToGymCalls = [];

const ScannerMock = {
  async findOne(query) {
    if (query && query._id !== undefined) {
      return scannerDocs.find((d) => d._id === query._id && d.gymId === query.gymId) || null;
    }
    return scannerDocs.find((d) => d.serial === query.serial) || null;
  }
};

const MemberMock = {
  async findOne(query) {
    if (!query) return null;
    const gymId = query.gymId;
    const deviceUserId = query["biometrics.deviceUserId"];
    const cardId = query["biometrics.cardId"];
    if (deviceUserId !== undefined) {
      return memberDocs.find((m) => m.gymId === gymId && m.biometrics && m.biometrics.deviceUserId === deviceUserId) || null;
    }
    if (cardId !== undefined) {
      return memberDocs.find((m) => m.gymId === gymId && m.biometrics && m.biometrics.cardId === cardId) || null;
    }
    return null;
  }
};

const PlanMock = {
  async findOne(query) {
    if (!query || query._id === undefined) return null;
    return planDocs.find(
      (p) => String(p._id) === String(query._id) && (!query.gymId || p.gymId === query.gymId)
    ) || null;
  }
};

const AttendanceMock = {
  async findOne(query) {
    return attendanceStore.find(
      (a) =>
        a.gymId === query.gymId &&
        String(a.member) === String(query.member) &&
        a.date === query.date &&
        a.deletedAt === null
    ) || null;
  },
  async create(doc) {
    if (
      attendanceStore.some(
        (a) => a.gymId === doc.gymId && String(a.member) === String(doc.member) && a.date === doc.date
      )
    ) {
      const err = new Error("E11000 duplicate key");
      err.code = 11000;
      throw err;
    }
    const created = Object.assign({ _id: nextId("att"), deletedAt: null, auditLogs: [] }, doc);
    created.save = async function save() { return this; };
    attendanceStore.push(created);
    return created;
  }
};

const ScannerEventMock = {
  async findOne(query) {
    return scannerEventStore.find((d) => d.deviceEventId === query.deviceEventId) || null;
  },
  async create(doc) {
    if (scannerEventStore.some((d) => d.deviceEventId === doc.deviceEventId)) {
      const err = new Error("E11000 duplicate key");
      err.code = 11000;
      throw err;
    }
    const created = Object.assign({ _id: nextId("sev") }, doc);
    scannerEventStore.push(created);
    return created;
  }
};

const DoorAuthorizationMock = {
  async create(doc) {
    if (doorAuthorizationStore.some((d) => d.tokenHash === doc.tokenHash)) {
      const err = new Error("E11000 duplicate key");
      err.code = 11000;
      throw err;
    }
    const created = Object.assign({ _id: nextId("door"), consumedAt: null }, doc);
    created.save = async function save() { return this; };
    doorAuthorizationStore.push(created);
    return created;
  }
};

const RealtimeMock = {
  emitToGym(gymId, eventName, payload) {
    emitToGymCalls.push({ gymId, eventName, payload });
    return true;
  }
};

function installMock(relPath, exports) {
  const abs = require.resolve(path.join(ROOT, relPath));
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports, children: [], paths: [] };
}

installMock("models/scanner.model.js", ScannerMock);
installMock("models/member.model.js", MemberMock);
installMock("models/plan.model.js", PlanMock);
installMock("models/attendance.model.js", AttendanceMock);
installMock("models/scannerEvent.model.js", ScannerEventMock);
installMock("models/doorAuthorization.model.js", DoorAuthorizationMock);
installMock("services/realtime.service.js", RealtimeMock);

const { processScannerEvent } = require(path.join(ROOT, "services/scanner.service.js"));
const { formatDateInTimezone, DEFAULT_TIMEZONE } = require(path.join(ROOT, "utils/date.js"));
const crypto = require("crypto");

const GYM_ID = "MAIN";
const BRANCH = "BR1";
const SCANNER_ID = "TEST-SCANNER-1";
const SCANNER_SERIAL = "SN123456";
const MEMBER_DEVICE_USER_ID = "1001";
const MEMBER_CARD_ID = "CARD-1001";

function resetState() {
  FAKE_ID.counter = 0;
  scannerDocs = [{
    _id: "scn_test_1",
    gymId: GYM_ID,
    branchCode: BRANCH,
    name: "Entry Scanner",
    brand: "eSSL",
    model: "K30 Pro",
    deviceId: SCANNER_ID,
    serial: SCANNER_SERIAL,
    status: "online",
    apiKeyHash: "test-key-hash",
    deviceTimezone: "Asia/Kolkata",
    settings: { enforceMembership: true, enableCheckOutOnSecondScan: true },
    gates: []
  }];
  const now = new Date();
  const startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000); // started yesterday
  const expiryDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // expires in 30 days
  memberDocs = [{
    _id: "mem_test_1",
    gymId: GYM_ID,
    branchCode: BRANCH,
    status: "active",
    paymentStatus: "paid",
    isActivePlan: true,
    currentPlan: "plan_test_1",
    membershipStartDate: startDate,
    membershipExpiryDate: expiryDate,
    user: "user_test_1",
    biometrics: { deviceUserId: MEMBER_DEVICE_USER_ID, cardId: MEMBER_CARD_ID }
  }];
  planDocs = [{
    _id: "plan_test_1",
    gymId: GYM_ID,
    branchCode: BRANCH,
    name: "Test Plan",
    durationDays: 30
  }];
  attendanceStore = [];
  scannerEventStore = [];
  doorAuthorizationStore = [];
  emitToGymCalls = [];
}

function makeAttendance(overrides = {}) {
  const today = getTodayDate();
  const att = {
    _id: nextId("att"),
    gymId: GYM_ID,
    member: "mem_test_1",
    date: today,
    checkIn: null,
    checkOut: null,
    status: "present",
    source: "scanner",
    scanner: "scn_test_1",
    eventType: "fingerprint",
    deviceEventId: "old",
    timezone: "Asia/Kolkata",
    membershipValidAtEvent: true,
    membershipValidatedAt: new Date(),
    auditLogs: [],
    deletedAt: null,
    save: async function() { return this; },
    ...overrides
  };
  return att;
}

function makeEvent(overrides = {}) {
  const now = new Date();
  return {
    userId: MEMBER_DEVICE_USER_ID,
    verified: true,
    eventType: "fingerprint",
    timestamp: now.toISOString(),
    deviceEventId: `${SCANNER_ID}:${now.getTime()}`,
    ...overrides
  };
}

function makeCheckoutEvent(overrides = {}) {
  const now = new Date();
  return {
    userId: MEMBER_DEVICE_USER_ID,
    verified: true,
    eventType: "fingerprint",
    timestamp: now.toISOString(),
    deviceEventId: `${SCANNER_ID}:${now.getTime()}`,
    ...overrides
  };
}

function getTodayDate() {
  return formatDateInTimezone(new Date(), DEFAULT_TIMEZONE);
}

describe("Door Authorization Notification", () => {
  beforeEach(() => {
    resetState();
    console.log('[TEST] resetState called, emitToGymCalls length:', emitToGymCalls.length);
  });

  test("emits door:authorization event on successful check-in (existing attendance)", async () => {
    const today = getTodayDate();
    const existingAttendance = makeAttendance({ _id: "att_existing_1", checkIn: null, checkOut: null });
    attendanceStore.push(existingAttendance);

    const event = makeEvent();
    const result = await processScannerEvent({ scanner: scannerDocs[0], event });

    assert.equal(result.status, "checkin");
    assert.ok(result.authorization);
    const doorAuthCalls = emitToGymCalls.filter(c => c.eventName === "door:authorization");
    assert.equal(doorAuthCalls.length, 1);
    const call = doorAuthCalls[0];
    assert.equal(call.gymId, GYM_ID);
    assert.equal(call.eventName, "door:authorization");
    assert.ok(call.payload.token);
    assert.ok(call.payload.expiresAt);
    assert.equal(call.payload.scannerId, SCANNER_ID);
    assert.equal(call.payload.memberId, "mem_test_1");
    assert.equal(call.payload.attendanceId, "att_existing_1");
  });

  test("emits door:authorization event on successful check-in (new attendance)", async () => {
    const event = makeEvent();
    const result = await processScannerEvent({ scanner: scannerDocs[0], event });

    assert.equal(result.status, "checkin");
    assert.ok(result.authorization);
    const doorAuthCalls = emitToGymCalls.filter(c => c.eventName === "door:authorization");
    assert.equal(doorAuthCalls.length, 1);
    const call = doorAuthCalls[0];
    assert.equal(call.gymId, GYM_ID);
    assert.equal(call.eventName, "door:authorization");
    assert.ok(call.payload.token);
    assert.ok(call.payload.expiresAt);
    assert.equal(call.payload.scannerId, SCANNER_ID);
    assert.equal(call.payload.memberId, "mem_test_1");
    assert.ok(call.payload.attendanceId.startsWith("att_"));
  });

  test("does NOT emit door:authorization on checkout", async () => {
    const today = getTodayDate();
    const existingAttendance = makeAttendance({ 
      _id: "att_checkout_1", 
      checkIn: new Date(Date.now() - 3600000), 
      checkOut: null 
    });
    attendanceStore.push(existingAttendance);

    const event = makeCheckoutEvent();
    const result = await processScannerEvent({ scanner: scannerDocs[0], event });

    assert.equal(result.status, "checkout");
    const doorAuthCalls = emitToGymCalls.filter(c => c.eventName === "door:authorization");
    assert.equal(doorAuthCalls.length, 0);
  });

  test("does NOT emit door:authorization when member not found", async () => {
    const event = makeEvent({ userId: "UNKNOWN_USER" });
    const result = await processScannerEvent({ scanner: scannerDocs[0], event });

    assert.equal(result.status, "denied");
    assert.equal(result.reason, "unknown_user");
    assert.equal(emitToGymCalls.length, 0);
  });

  test("does NOT emit door:authorization when verification fails", async () => {
    const event = makeEvent({ verified: false });
    const result = await processScannerEvent({ scanner: scannerDocs[0], event });

    assert.equal(result.status, "denied");
    assert.equal(result.reason, "not_matched");
    assert.equal(emitToGymCalls.length, 0);
  });

  test("does NOT emit door:authorization when membership ineligible", async () => {
    // Use expired membership
    memberDocs[0].membershipExpiryDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // expired yesterday
    const event = makeEvent();
    const result = await processScannerEvent({ scanner: scannerDocs[0], event });

    assert.equal(result.status, "denied");
    assert.equal(result.reason, "expired");
    assert.equal(emitToGymCalls.length, 0);
  });

  test("does NOT emit door:authorization on branch mismatch", async () => {
    scannerDocs[0].branchCode = "OTHER_BRANCH";
    const event = makeEvent();
    const result = await processScannerEvent({ scanner: scannerDocs[0], event });

    assert.equal(result.status, "denied");
    assert.equal(result.reason, "branch_mismatch");
    assert.equal(emitToGymCalls.length, 0);
  });

  test("does NOT emit door:authorization on duplicate event", async () => {
    const event = makeEvent();
    await processScannerEvent({ scanner: scannerDocs[0], event });
    emitToGymCalls = [];

    const result = await processScannerEvent({ scanner: scannerDocs[0], event });

    assert.equal(result.status, "duplicate");
    assert.equal(emitToGymCalls.length, 0);
  });

  test("payload includes all required fields for ESP32 redemption", async () => {
    const event = makeEvent();
    const result = await processScannerEvent({ scanner: scannerDocs[0], event });

    const doorAuthCalls = emitToGymCalls.filter(c => c.eventName === "door:authorization");
    const call = doorAuthCalls[0];
    const payload = call.payload;
    assert.ok(typeof payload.token === "string" && payload.token.length > 0);
    assert.ok(payload.expiresAt instanceof Date);
    assert.ok(payload.expiresAt > new Date());
    assert.equal(typeof payload.scannerId, "string");
    assert.equal(typeof payload.memberId, "string");
    assert.equal(typeof payload.attendanceId, "string");
  });
});