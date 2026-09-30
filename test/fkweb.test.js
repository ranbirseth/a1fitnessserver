// ============================================================
// RS9n / FkWeb adapter tests
//
// Runs with `npm test` (node --test). No network, no database, no production
// service is contacted: the Mongoose models are replaced with in-memory fakes
// through the require cache BEFORE the modules under test are loaded, so the
// real services/scanner.service.js pipeline executes against fake collections.
//
// The real Express middleware ordering from server.js is replicated so the
// ordering guarantee (raw parser registered BEFORE the global express.json) is
// genuinely exercised.
// ============================================================

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const http = require("http");
const net = require("net");

const ROOT = path.join(__dirname, "..");

// ------------------------------------------------------------
// In-memory model fakes
// ------------------------------------------------------------

let scannerDocs = [];
let memberDocs = [];
let attendanceStore = [];
let scannerEventStore = [];

const FAKE_ID = { counter: 0 };
const nextId = (prefix) => `${prefix}_${++FAKE_ID.counter}`;

const ScannerMock = {
  async findOne(query) {
    return scannerDocs.find((d) => d.serial === query.serial) || null;
  }
};

const MemberMock = {
  async findOne(query) {
    const deviceUserId = query["biometrics.deviceUserId"];
    if (deviceUserId === undefined) return null;
    return memberDocs.find((m) => m.biometrics && m.biometrics.deviceUserId === deviceUserId) || null;
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

function installMock(relPath, exports) {
  const abs = require.resolve(path.join(ROOT, relPath));
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports, children: [], paths: [] };
}

installMock("models/scanner.model.js", ScannerMock);
installMock("models/member.model.js", MemberMock);
installMock("models/attendance.model.js", AttendanceMock);
installMock("models/scannerEvent.model.js", ScannerEventMock);

// Now load the modules under test (they will pick up the fakes).
const parser = require(path.join(ROOT, "utils/fkwebParser.js"));
const { findScannerByDevId } = require(path.join(ROOT, "services/fkwebDeviceLookup.js"));
const { processScannerEvent } = require(path.join(ROOT, "services/scanner.service.js"));
const { handleFkWeb, fkwebErrorHandler, ACK_HEADERS } = require(path.join(ROOT, "controllers/fkweb.controller.js"));

// ------------------------------------------------------------
// Test app: replicates the server.js middleware ordering exactly
// ------------------------------------------------------------

const express = require(path.join(ROOT, "node_modules/express"));
const rateLimit = require(path.join(ROOT, "node_modules/express-rate-limit"));

const app = express();
app.set("trust proxy", 1);

app.use("/iclock", express.text({ type: "*/*", limit: "5mb" }));
app.use("/iclock", require(path.join(ROOT, "routes/adms.routes")));

const fkwebRoutes = require(path.join(ROOT, "routes/fkweb.routes"));
app.post("/", fkwebRoutes);
app.post("/fkweb", fkwebRoutes);

app.use(express.json({ limit: "1mb" }));

// Same bypass logic as server.js after the change.
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    skip: (req) =>
      ["/api/scanners", "/iclock"].some((p) => req.path.startsWith(p)) ||
      (req.method === "POST" && (req.path === "/" || req.path === "/fkweb"))
  })
);

let server;
let port;

function resetFixtures() {
  scannerDocs = [
    {
      _id: "scn_rs9n_b2",
      gymId: "MAIN",
      branchCode: "BR2",
      name: "RS9n Branch 2",
      brand: "realtime",
      model: "RS9n",
      deviceId: "RS9N-BRANCH-2",
      serial: "RSS202503111226",
      deviceTimezone: "Asia/Kolkata",
      status: "online",
      settings: { enableCheckOutOnSecondScan: true },
      lastSeen: null,
      save: async function save() { return this; }
    }
  ];
  memberDocs = [
    { _id: "mem_b1", gymId: "MAIN", user: "u1", branchCode: "MAIN", status: "active", paymentStatus: "paid", biometrics: { deviceUserId: "1001" } },
    { _id: "mem_b2", gymId: "MAIN", user: "u2", branchCode: "BR2", status: "active", paymentStatus: "paid", biometrics: { deviceUserId: "2002" } }
  ];
  attendanceStore = [];
  scannerEventStore = [];
}

// ------------------------------------------------------------
// HTTP helpers
// ------------------------------------------------------------

function request(options, bodyBuffer) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, ...options }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (bodyBuffer !== undefined) req.write(bodyBuffer);
    req.end();
  });
}

function fkweb(requestCode, devId, body, extraHeaders = {}) {
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  const headers = {
    "Content-Type": "application/octet-stream",
    "Content-Length": payload.length,
    ...extraHeaders
  };
  if (requestCode !== undefined) headers["request_code"] = requestCode;
  if (devId !== undefined) headers["dev_id"] = devId;
  return request({ method: "POST", path: "/", headers }, payload);
}

// Sends the exact bytes a physical RS9n emits: absolute-form request target,
// HTTP/1.0, underscore headers, Connection: close.
function rawDeviceRequest(requestTarget, headers, bodyBuffer) {
  return new Promise((resolve, reject) => {
    const payload = bodyBuffer === undefined ? Buffer.alloc(0) : bodyBuffer;
    // Each entry already ends with CRLF, so Content-Length must be appended
    // directly - adding a blank line here would terminate the header block early
    // and push Content-Length/Connection into the body.
    const headerLines = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join("");
    const raw =
      `POST ${requestTarget} HTTP/1.0\r\n` +
      `${headerLines}` +
      `Content-Length: ${payload.length}\r\nConnection: close\r\n\r\n`;

    const socket = net.connect(port, "127.0.0.1");
    let buffer = "";
    socket.on("error", reject);
    socket.on("connect", () => { socket.write(raw); socket.write(payload); });
    socket.on("data", (d) => { buffer += d.toString("binary"); });
    socket.on("close", () => resolve(buffer));
  });
}

const GLOG = (userId, ioTime, verifyMode = 2, ioMode = 1) =>
  JSON.stringify({ fk_bin_data_lib: "M50", user_id: userId, verify_mode: verifyMode, io_mode: ioMode, io_time: ioTime });

// ------------------------------------------------------------
// 1. Pure parser unit tests
// ------------------------------------------------------------

test("parseFkWebIoTime parses the compact FkWeb format in the scanner timezone", () => {
  const d = parser.parseFkWebIoTime("20260930111551", "Asia/Kolkata");
  assert.ok(d instanceof Date);
  assert.equal(d.toISOString(), "2026-09-30T05:45:51.000Z");
});

test("parseFkWebIoTime rejects malformed and missing values without throwing", () => {
  for (const bad of ["", "not-a-time", "2026093011", "20261330111551", "20260930119999", null, undefined, 12345]) {
    assert.equal(parser.parseFkWebIoTime(bad, "Asia/Kolkata"), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("extractJsonObject recovers the envelope from a JSON + binary body", () => {
  const binaryTail = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f, 0xc3, 0x28, 0xa0]);
  const envelope = JSON.stringify({ user_id: "00000001", user_name: "badsha" });
  const body = Buffer.concat([Buffer.from(envelope, "utf8"), binaryTail]);
  const parsed = parser.extractJsonObject(body);
  assert.equal(parsed.user_id, "00000001");
  assert.equal(parsed.user_name, "badsha");
  // The binary tail must remain untouched outside the parser.
  assert.deepEqual(body.subarray(Buffer.byteLength(envelope)), binaryTail);
});

test("extractJsonObject handles braces inside string values and escapes", () => {
  const body = Buffer.from('{"user_id":"0001","note":"a{b}c\\"d","n":{"x":1}}', "utf8");
  const parsed = parser.extractJsonObject(body);
  assert.equal(parsed.user_id, "0001");
  // JSON.parse consumes the \" escape, so the decoded value keeps only the quote.
  assert.equal(parsed.note, 'a{b}c"d');
  assert.equal(parsed.n.x, 1);
});

test("extractJsonObject returns null for every non-envelope body", () => {
  for (const bad of [Buffer.alloc(0), Buffer.from("no json here"), Buffer.from('{"a":'), Buffer.from("[1,2,3]"), Buffer.from([0xff, 0xfe, 0x00])]) {
    assert.equal(parser.extractJsonObject(bad), null);
  }
});

test("extractJsonObject is bounded and does not scan past the 4 KiB window", () => {
  const huge = Buffer.from('{"pad":"' + "A".repeat(8000) + '","user_id":"00000258"}', "utf8");
  assert.equal(parser.extractJsonObject(huge), null);
});

test("makeFkWebDeviceEventId is deterministic and independent of arrival time", () => {
  resetFixtures();
  const scanner = scannerDocs[0];
  const args = { scanner, userId: "00000258", ioTimeRaw: "20260930111551", ioMode: 1, verifyMode: 2 };
  const withTime = (iso) => Object.assign({}, args, { timestamp: new Date(iso) });
  const a = parser.makeFkWebDeviceEventId(withTime("2026-09-30T05:45:51.000Z"));
  const b = parser.makeFkWebDeviceEventId(withTime("2026-09-30T05:45:51.000Z"));
  assert.equal(a, b, "identical inputs must yield an identical id");
  assert.ok(a.startsWith("RSS202503111226:00000258:"), "must be prefixed by the registered serial");
  assert.ok(a.endsWith(":20260930111551"), "must include the raw io_time");
  assert.ok(!a.includes(String(Date.now())), "must not embed a wall-clock arrival time");
});

test("makeFkWebDeviceEventId separates different io_time / io_mode / verify_mode", () => {
  const scanner = { serial: "RSS202503111226" };
  const base = { scanner, userId: "00000258", timestamp: new Date("2026-09-30T05:45:51.000Z") };
  const ids = new Set([
    parser.makeFkWebDeviceEventId({ ...base, ioTimeRaw: "20260930111551", ioMode: 1, verifyMode: 2 }),
    parser.makeFkWebDeviceEventId({ ...base, ioTimeRaw: "20260930111552", ioMode: 1, verifyMode: 2 }),
    parser.makeFkWebDeviceEventId({ ...base, ioTimeRaw: "20260930111551", ioMode: 2, verifyMode: 2 }),
    parser.makeFkWebDeviceEventId({ ...base, ioTimeRaw: "20260930111551", ioMode: 1, verifyMode: 1 })
  ]);
  assert.equal(ids.size, 4, "each field change must produce a distinct id");
});

test("toFkWebScannerEvent maps the captured realtime_glog shape", () => {
  resetFixtures();
  const built = parser.toFkWebScannerEvent(
    { fk_bin_data_lib: "M50", user_id: "00000258", verify_mode: 2, io_mode: 1, io_time: "20260930111551" },
    scannerDocs[0]
  );
  assert.equal(built.error, undefined);
  assert.equal(built.event.userId, "258", "zero padding is stripped for lookup");
  assert.equal(built.event.rawUserId, "00000258", "raw padded id is retained for the fallback candidate");
  assert.equal(built.event.verified, true);
  assert.equal(built.event.eventType, "card");
  assert.ok(built.event.timestamp instanceof Date);
});

test("toFkWebScannerEvent reports safe error codes for bad records", () => {
  resetFixtures();
  const scanner = scannerDocs[0];
  assert.equal(parser.toFkWebScannerEvent({ user_id: "", io_time: "20260930111551" }, scanner).error, "missing_user_id");
  assert.equal(parser.toFkWebScannerEvent({ user_id: "1", io_time: "nope" }, scanner).error, "invalid_io_time");
  assert.equal(parser.toFkWebScannerEvent({ io_time: "20260930111551" }, scanner).error, "missing_user_id");
  assert.equal(parser.toFkWebScannerEvent(null, scanner).error, "unparseable_body");
});

test("mapVerifyModeToEventType only ever returns values present in the model enums", () => {
  const allowed = new Set(["fingerprint", "card", "pin", "face"]);
  for (const mode of [0, 1, 2, 3, 4, 5, 6, 7, 8, 99, -1, null, undefined, "x", ""]) {
    assert.ok(allowed.has(parser.mapVerifyModeToEventType(mode)), `verify_mode ${mode} produced an invalid eventType`);
  }
});

test("readFkWebRequestMeta survives underscore, dash and mangled header spellings", () => {
  const mk = (headers) => ({ headers, query: {} });
  const expected = { requestCode: "realtime_glog", devId: "RSS202503111226", transId: "T1", blkNo: "7" };
  const variants = [
    { request_code: "realtime_glog", dev_id: "RSS202503111226", trans_id: "T1", blk_no: "7" },
    { "request-code": "realtime_glog", "dev-id": "RSS202503111226", "trans-id": "T1", "blk-no": "7" },
    { "x-request-code": "realtime_glog", "x-dev-id": "RSS202503111226", "x-trans-id": "T1", "x-blk-no": "7" },
    { devId: "RSS202503111226", requestCode: "realtime_glog", transId: "T1", blkNo: "7" },
    { REQUEST_CODE: "realtime_glog", DEV_ID: "RSS202503111226" }
  ];
  for (const headers of variants) {
    const meta = parser.readFkWebRequestMeta(mk(headers));
    assert.equal(meta.requestCode, expected.requestCode);
    assert.equal(meta.devId, expected.devId);
  }
  assert.equal(parser.readFkWebRequestMeta(mk({})).devId, "");
  assert.equal(parser.readFkWebRequestMeta(mk({})).requestCode, "");
});

test("isFkWebDevicePush is POST-only and path-exact so GET / stays rate limited", () => {
  assert.equal(parser.isFkWebDevicePush({ method: "POST", path: "/" }), true);
  assert.equal(parser.isFkWebDevicePush({ method: "POST", path: "/fkweb" }), true);
  assert.equal(parser.isFkWebDevicePush({ method: "GET", path: "/" }), false);
  assert.equal(parser.isFkWebDevicePush({ method: "GET", path: "/api/scanners" }), false);
  assert.equal(parser.isFkWebDevicePush({ method: "POST", path: "/api/scanners/events" }), false);
  assert.equal(parser.isFkWebDevicePush({ method: "POST", path: "/iclock/cdata" }), false);
});

test("findScannerByDevId resolves the registered Scanner and rejects unknown devices", async () => {
  resetFixtures();
  const found = await findScannerByDevId("RSS202503111226");
  assert.equal(found.branchCode, "BR2");
  assert.equal(found.gymId, "MAIN");
  assert.equal(await findScannerByDevId("RSS000000000000"), null);
  assert.equal(await findScannerByDevId(""), null);
  assert.equal(await findScannerByDevId(undefined), null);
});

// ------------------------------------------------------------
// 2. Branch isolation through the REAL processScannerEvent
// ------------------------------------------------------------

test("BRANCH ISOLATION: Branch-2 scanner + Branch-1 member is denied, no attendance created", async () => {
  resetFixtures();
  const scanner = await findScannerByDevId("RSS202503111226");
  const built = parser.toFkWebScannerEvent(
    { user_id: "1001", verify_mode: 2, io_mode: 1, io_time: "20260930111551" },
    scanner
  );
  const result = await processScannerEvent({ scanner, event: built.event });
  assert.equal(result.status, "denied");
  assert.equal(result.reason, "branch_mismatch");
  assert.equal(attendanceStore.length, 0, "no Attendance row may be created");
  const ev = scannerEventStore[0];
  assert.equal(ev.decision, "deny");
  assert.equal(ev.reason, "branch_mismatch");
  assert.equal(ev.branchCode, "BR2", "event must be recorded against the scanner's branch");
});

test("BRANCH ISOLATION: Branch-2 scanner + Branch-2 member is accepted", async () => {
  resetFixtures();
  const scanner = await findScannerByDevId("RSS202503111226");
  const built = parser.toFkWebScannerEvent(
    { user_id: "2002", verify_mode: 2, io_mode: 1, io_time: "20260930111551" },
    scanner
  );
  const result = await processScannerEvent({ scanner, event: built.event });
  assert.equal(result.status, "checkin");
  assert.equal(attendanceStore.length, 1);
  assert.equal(attendanceStore[0].branchCode, "BR2");
  assert.equal(attendanceStore[0].gymId, "MAIN");
  assert.equal(attendanceStore[0].source, "scanner");
  assert.equal(attendanceStore[0].date, "2026-09-30");
});

test("BRANCH ISOLATION: the mirrored case (Branch-1 scanner + Branch-2 member) is denied", async () => {
  resetFixtures();
  // Simulates a K30-style Branch-1 scanner fed a Branch-2 member id.
  const scanner = Object.assign({}, scannerDocs[0], { branchCode: "MAIN" });
  const built = parser.toFkWebScannerEvent(
    { user_id: "2002", verify_mode: 2, io_mode: 1, io_time: "20260930111551" },
    scanner
  );
  const result = await processScannerEvent({ scanner, event: built.event });
  assert.equal(result.status, "denied");
  assert.equal(result.reason, "branch_mismatch");
  assert.equal(attendanceStore.length, 0);
});

test("DUPLICATE SAFETY: a replayed realtime_glog never creates a second attendance row", async () => {
  resetFixtures();
  const scanner = await findScannerByDevId("RSS202503111226");
  const build = () =>
    parser.toFkWebScannerEvent({ user_id: "2002", verify_mode: 2, io_mode: 1, io_time: "20260930111551" }, scanner).event;

  const first = await processScannerEvent({ scanner, event: build() });
  const second = await processScannerEvent({ scanner, event: build() });
  const third = await processScannerEvent({ scanner, event: build() });

  assert.equal(first.status, "checkin");
  assert.equal(second.status, "duplicate");
  assert.equal(third.status, "duplicate");
  assert.equal(attendanceStore.length, 1, "three identical requests must yield one attendance row");
  assert.equal(scannerEventStore.length, 1);
});

test("HISTORICAL REPLAY: an old record is written to its own date and cannot touch today's row", async () => {
  resetFixtures();
  const scanner = await findScannerByDevId("RSS202503111226");

  // Today first, exactly as it would already exist in production.
  const today = parser.toFkWebScannerEvent({ user_id: "2002", io_mode: 1, io_time: "20260930111551" }, scanner).event;
  await processScannerEvent({ scanner, event: today });
  assert.equal(attendanceStore.length, 1);
  assert.equal(attendanceStore[0].date, "2026-09-30");
  assert.ok(attendanceStore[0].checkOut == null, "a first scan is a check-in with no check-out");

  // A June record replayed afterwards.
  const historical = parser.toFkWebScannerEvent({ user_id: "2002", io_mode: 1, io_time: "20260615103000" }, scanner).event;
  const result = await processScannerEvent({ scanner, event: historical });

  assert.equal(result.status, "checkin");
  assert.equal(attendanceStore.length, 2, "the historical record gets its own dated row");
  const june = attendanceStore.find((a) => a.date === "2026-06-15");
  const sept = attendanceStore.find((a) => a.date === "2026-09-30");
  assert.ok(june, "June row exists");
  // processScannerEvent() derives "today" from the event timestamp, so a replayed
  // June record can never reach today's row. This is the checkout-interaction
  // risk the investigation flagged, and it does not materialise.
  assert.ok(sept.checkOut == null, "today's row must NOT be check-out by a June replay");
  assert.ok(sept.checkIn instanceof Date);
});

test("HISTORICAL REPLAY: replaying the same June record many times stays idempotent", async () => {
  resetFixtures();
  const scanner = await findScannerByDevId("RSS202503111226");
  for (let i = 0; i < 5; i++) {
    const event = parser.toFkWebScannerEvent({ user_id: "2002", io_mode: 1, io_time: "20260615103000" }, scanner).event;
    await processScannerEvent({ scanner, event });
  }
  assert.equal(attendanceStore.length, 1, "five replays of one record produce one row");
});

test("UNKNOWN USER and ELIGIBILITY are denied without creating attendance", async () => {
  resetFixtures();
  const scanner = await findScannerByDevId("RSS202503111226");

  const unknown = parser.toFkWebScannerEvent({ user_id: "99999999", io_mode: 1, io_time: "20260930111551" }, scanner).event;
  const r1 = await processScannerEvent({ scanner, event: unknown });
  assert.equal(r1.reason, "unknown_user");

  memberDocs[1].status = "expired";
  const expired = parser.toFkWebScannerEvent({ user_id: "2002", io_mode: 1, io_time: "20260930112000" }, scanner).event;
  const r2 = await processScannerEvent({ scanner, event: expired });
  assert.equal(r2.status, "denied");
  assert.equal(r2.reason, "ineligible");
  assert.equal(attendanceStore.length, 0);
});

test("zero-padded deviceUserId is stored per member and still resolves", async () => {
  resetFixtures();
  memberDocs.push({
    _id: "mem_padded", gymId: "MAIN", user: "u3", branchCode: "BR2",
    status: "active", paymentStatus: "paid", biometrics: { deviceUserId: "00000258" }
  });
  const scanner = await findScannerByDevId("RSS202503111226");
  const event = parser.toFkWebScannerEvent({ user_id: "00000258", io_mode: 1, io_time: "20260930111551" }, scanner).event;
  const result = await processScannerEvent({ scanner, event });
  assert.equal(result.status, "checkin", "rawUserId must let the padded stored value match");
  assert.equal(attendanceStore[0].member, "mem_padded");
});

test("SECOND SCAN within the same day performs a checkout (existing shared behaviour)", async () => {
  resetFixtures();
  const scanner = await findScannerByDevId("RSS202503111226");
  const inEvent = parser.toFkWebScannerEvent({ user_id: "2002", io_mode: 1, io_time: "20260930111551" }, scanner).event;
  const outEvent = parser.toFkWebScannerEvent({ user_id: "2002", io_mode: 2, io_time: "20260930183000" }, scanner).event;
  assert.equal((await processScannerEvent({ scanner, event: inEvent })).status, "checkin");
  assert.equal((await processScannerEvent({ scanner, event: outEvent })).status, "checkout");
  assert.equal(attendanceStore.length, 1);
  assert.ok(attendanceStore[0].checkOut instanceof Date);
});

// ------------------------------------------------------------
// 3. HTTP contract tests against the real routing stack
// ------------------------------------------------------------

test("STARTUP", async () => {
  resetFixtures();
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  port = server.address().port;
  assert.ok(port > 0);
});

test("ACK: realtime_glog returns exactly HTTP 200 + response_code: OK + Content-Length: 0", async () => {
  resetFixtures();
  const res = await fkweb("realtime_glog", "RSS202503111226", GLOG("99999999", "20260930111551"));
  assert.equal(res.status, 200);
  assert.equal(res.headers["response_code"], "OK");
  assert.equal(res.headers["content-length"], "0");
  assert.equal(res.headers["connection"], "close");
  assert.equal(res.body.length, 0, "body must be empty");
  assert.equal(ACK_HEADERS["Content-Length"], "0");
  assert.equal(ACK_HEADERS.response_code, "OK");
});

test("ACK: a denied branch-mismatch scan still returns the 200 protocol ACK", async () => {
  resetFixtures();
  const res = await fkweb("realtime_glog", "RSS202503111226", GLOG("1001", "20260930111551"));
  assert.equal(res.status, 200);
  assert.equal(res.headers["response_code"], "OK");
  assert.equal(attendanceStore.length, 0, "Branch-1 member on the Branch-2 device must not create attendance");
  assert.equal(scannerEventStore[0].reason, "branch_mismatch");
});

test("ACK: an accepted Branch-2 scan creates Branch-2 attendance", async () => {
  resetFixtures();
  const res = await fkweb("realtime_glog", "RSS202503111226", GLOG("2002", "20260930111551"));
  assert.equal(res.status, 200);
  assert.equal(attendanceStore.length, 1);
  assert.equal(attendanceStore[0].branchCode, "BR2");
});

test("DUPLICATE: the same realtime_glog sent 3x over HTTP yields one attendance row", async () => {
  resetFixtures();
  for (let i = 0; i < 3; i++) {
    const res = await fkweb("realtime_glog", "RSS202503111226", GLOG("2002", "20260930111551"));
    assert.equal(res.status, 200, "a retry must still be ACKed, never 4xx/5xx");
    assert.equal(res.headers["response_code"], "OK");
  }
  assert.equal(attendanceStore.length, 1);
  assert.equal(scannerEventStore.length, 1);
});

test("ROUTING: the exact absolute-form RS9n request line reaches the endpoint", async () => {
  resetFixtures();
  const body = Buffer.from(GLOG("99999999", "20260930111551"), "utf8");
  const raw = await rawDeviceRequest(
    "http://127.0.0.1:88/",
    { "request_code": "realtime_glog", "dev_id": "RSS202503111226", "Content-Type": "application/octet-stream", trans_id: "TEST001" },
    body
  );
  assert.ok(raw.startsWith("HTTP/1.1 200 OK"), `expected 200, got: ${raw.split("\r\n")[0]}`);
  assert.ok(/response_code:\s*OK/i.test(raw), "response_code header must be present");
  assert.ok(/content-length:\s*0/i.test(raw), "Content-Length: 0 must be present");
  assert.equal(attendanceStore.length, 0, "user 99999999 is unknown, so nothing is written");
});

test("ROUTING: an https absolute-form request target is handled identically", async () => {
  resetFixtures();
  const raw = await rawDeviceRequest(
    "https://a1fitnessserver.onrender.com/",
    { "request_code": "realtime_glog", "dev_id": "RSS202503111226", "Content-Type": "application/octet-stream" },
    Buffer.from(GLOG("2002", "20260930111551"), "utf8")
  );
  assert.ok(raw.startsWith("HTTP/1.1 200 OK"), raw.split("\r\n")[0]);
  assert.equal(attendanceStore.length, 1);
});

test("ROUTING: the /fkweb alias behaves identically to the absolute-form root", async () => {
  resetFixtures();
  const payload = Buffer.from(GLOG("2002", "20260930111551"), "utf8");
  const res = await request(
    {
      method: "POST",
      path: "/fkweb",
      headers: {
        "Content-Type": "application/octet-stream",
        request_code: "realtime_glog",
        dev_id: "RSS202503111226",
        "Content-Length": payload.length
      }
    },
    payload
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers["response_code"], "OK");
  assert.equal(attendanceStore.length, 1);
});

test("ACK: receive_cmd, realtime_enroll_data and send_cmd_result persist nothing", async () => {
  resetFixtures();
  for (const code of ["receive_cmd", "send_cmd_result"]) {
    const res = await fkweb(code, "RSS202503111226", JSON.stringify({ dev_id: "RSS202503111226", cmd_id: 1 }));
    assert.equal(res.status, 200, `${code} must be ACKed`);
    assert.equal(res.headers["response_code"], "OK");
  }

  // realtime_enroll_data: JSON envelope followed by real fingerprint template bytes.
  const envelope = JSON.stringify({
    user_id: "00000001", user_name: "badsha", user_privilege: 2, user_enabled: 1, user_depart_id: 0,
    enroll_data_array: [{ backup_number: 0, enroll_data: "BIN_1" }]
  });
  const template = Buffer.alloc(1024);
  for (let i = 0; i < 1024; i++) template[i] = (i * 37) % 256;
  const res = await fkweb("realtime_enroll_data", "RSS202503111226", Buffer.concat([Buffer.from(envelope, "utf8"), template]), { blk_no: "1" });
  assert.equal(res.status, 200);
  assert.equal(res.headers["response_code"], "OK");
  assert.equal(attendanceStore.length, 0, "enrollment must never touch attendance");
  assert.equal(scannerEventStore.length, 0, "enrollment must not be persisted");
  assert.equal(memberDocs[0].biometrics.fingerprints, undefined, "member biometrics must be untouched");
});

test("UNKNOWN request_code is ACKed with a warning, never a 4xx", async () => {
  resetFixtures();
  const res = await fkweb("some_future_code", "RSS202503111226", "{}");
  assert.equal(res.status, 200);
  assert.equal(res.headers["response_code"], "OK");
});

test("UNKNOWN dev_id is ACKed, not 404", async () => {
  resetFixtures();
  const res = await fkweb("realtime_glog", "RSS000000000000", GLOG("2002", "20260930111551"));
  assert.equal(res.status, 200, "an unregistered device must still receive a protocol ACK");
  assert.equal(attendanceStore.length, 0);
});

test("DISABLED scanner is rejected safely", async () => {
  resetFixtures();
  scannerDocs[0].status = "disabled";
  const res = await fkweb("realtime_glog", "RSS202503111226", GLOG("2002", "20260930111551"));
  assert.equal(res.status, 200);
  assert.equal(attendanceStore.length, 0, "a disabled scanner must not create attendance");
});

test("ROBUSTNESS: malformed and hostile bodies are ACKed and never crash the server", async () => {
  resetFixtures();
  const bodies = [
    Buffer.alloc(0),
    Buffer.from('{"user_id": broken'),
    Buffer.from("{"),
    Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02, 0x03]),
    Buffer.from("not json at all"),
    Buffer.from('[{"user_id":"2002"}]'),
    Buffer.from(GLOG("2002", "garbage-time")),
    Buffer.from(GLOG("", "20260930111551")),
    Buffer.alloc(3 * 1024 * 1024, 0x41)
  ];
  for (const body of bodies) {
    const res = await fkweb("realtime_glog", "RSS202503111226", body);
    assert.equal(res.status, 200, `expected an ACK for a ${body.length}-byte body`);
    assert.equal(res.headers["response_code"], "OK");
  }
  // Missing dev_id / request_code.
  for (const r of [
    await fkweb(undefined, "RSS202503111226", GLOG("2002", "20260930111551")),
    await fkweb("realtime_glog", undefined, GLOG("2002", "20260930111551"))
  ]) {
    assert.equal(r.status, 200);
  }
  assert.equal(attendanceStore.length, 0, "no malformed body may produce attendance");

  // The server is still fully functional afterwards.
  const after = await fkweb("realtime_glog", "RSS202503111226", GLOG("2002", "20260930111551"));
  assert.equal(after.status, 200);
  assert.equal(attendanceStore.length, 1, "server still processes correctly after the abuse run");
});

test("RATE LIMIT: 350 rapid device pushes are all ACKed (no 429 retry storm)", async () => {
  resetFixtures();
  // Bounded concurrency via a keep-alive agent: 350 simultaneous sockets would
  // overflow the listen backlog and produce spurious ECONNREFUSED, which says
  // nothing about the rate limiter.
  const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });
  const payload = Buffer.from(GLOG("99999999", "20260930111551"), "utf8");

  const results = [];
  for (let i = 0; i < 350; i++) {
    results.push(await request(
      {
        method: "POST",
        path: "/",
        agent,
        headers: {
          "Content-Type": "application/octet-stream",
          request_code: "realtime_glog",
          dev_id: "RSS202503111226",
          "Content-Length": payload.length
        }
      },
      payload
    ));
  }
  agent.destroy();

  assert.equal(results.filter((r) => r.status === 200).length, 350, "device pushes must bypass the API rate limiter");
  assert.equal(results.filter((r) => r.status === 429).length, 0);
});

test("K30 REGRESSION: the /iclock route is still mounted and still parses raw text bodies", async () => {
  resetFixtures();
  // No SN -> the route must respond with its own 400 plain-text contract,
  // proving the ADMS router and its error path are intact.
  const res = await request({ method: "POST", path: "/iclock/cdata", headers: { "Content-Type": "text/plain" } }, Buffer.from("", "utf8"));
  assert.equal(res.status, 400);
  assert.match(res.body.toString(), /SN/);

  // With an SN that is not registered, the route resolves and returns 404.
  const res2 = await request({ method: "POST", path: "/iclock/cdata?SN=UNKNOWNSERIAL&table=ATTLOG", headers: { "Content-Type": "text/plain" } }, Buffer.from("", "utf8"));
  assert.equal(res2.status, 404);
  assert.match(res2.body.toString(), /not registered/i);
});

test("K30 REGRESSION: /iclock still works after RS9n traffic and vice versa", async () => {
  resetFixtures();
  await fkweb("realtime_glog", "RSS202503111226", GLOG("2002", "20260930111551"));
  const iclock = await request({ method: "POST", path: "/iclock/cdata?SN=UNKNOWNSERIAL&table=ATTLOG", headers: { "Content-Type": "text/plain" } }, Buffer.from("", "utf8"));
  assert.equal(iclock.status, 404, "K30 route unaffected by RS9n traffic");

  scannerDocs[0].serial = "RSS202503111226";
  scannerDocs[0].brand = "eSSL";
  scannerDocs[0].model = "K30 Pro";
  scannerDocs[0].branchCode = "MAIN";
  memberDocs[0].branchCode = "MAIN";
  const k30 = await request(
    { method: "POST", path: "/iclock/cdata?SN=RSS202503111226&table=ATTLOG", headers: { "Content-Type": "text/plain" } },
    Buffer.from("1001\t2026-09-30 11:15:51\t1\t0\t0\t0", "utf8")
  );
  assert.equal(k30.status, 200, "K30 ATTLOG push must still be ACKed with 200");
  assert.equal(k30.body.toString().trim(), "OK", "K30 must still receive the plain-text OK ack");
  assert.ok(attendanceStore.some((a) => a.branchCode === "MAIN"), "K30 attendance must still be created");
});

test("SHUTDOWN", async () => {
  await new Promise((resolve) => server.close(resolve));
  assert.equal(server.listening, false);
});
