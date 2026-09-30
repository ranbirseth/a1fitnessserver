// ============================================================
// FKWEB CONTROLLER (realtime Biometric RS9n)
//
// ATTENDANCE INGESTION ONLY.
//
// request_code routing:
//   realtime_glog         -> the only type that reaches processScannerEvent()
//   realtime_enroll_data  -> ACK, nothing persisted, no template storage
//   receive_cmd           -> ACK, nothing persisted, no device commands issued
//   send_cmd_result       -> ACK, nothing persisted
//   anything else         -> ACK + warn log
//
// ACK CONTRACT (do not change without testing against the physical device):
// The RS9n was verified against a temporary local receiver that answered
//   HTTP/1.0 200 OK
//   response_code: OK
//   Connection: close
//   Content-Length: 0
// and the device accepted it and continued sending data. `response_code` is a
// response HEADER, and the body is empty. This is reproduced exactly, and is
// deliberately NOT res.status().json(), which would set a JSON body and break
// the agreed Content-Length: 0.
//
// Every path through this controller ends in an ACK, including denied scans,
// malformed bodies and internal errors. A non-2xx reply would make the device
// retry a record that can never succeed, producing an unbounded retry loop
// against production.
// ============================================================

const { asyncHandler } = require("../utils/asyncHandler");
const { processScannerEvent } = require("../services/scanner.service");
const { findScannerByDevId } = require("../services/fkwebDeviceLookup");
const {
  readFkWebRequestMeta,
  extractJsonObject,
  toFkWebScannerEvent
} = require("../utils/fkwebParser");

const ACK_HEADERS = {
  response_code: "OK",
  "Content-Type": "text/plain; charset=utf-8",
  "Content-Length": "0",
  Connection: "close"
};

// Scanner liveness is throttled so that a device replaying a large buffered
// history does not issue one Scanner write per record. `maintenance` is
// deliberately preserved; only an `offline` scanner is promoted to `online`.
const SCANNER_TOUCH_THROTTLE_MS = 60000;

function log(line) {
  console.log(line);
}

function warn(line) {
  console.warn(line);
}

function error(line) {
  console.error(line);
}

function sendFkWebAck(res) {
  if (res.headersSent) return;
  res.writeHead(200, ACK_HEADERS);
  res.end();
}

// Reads the body as a Buffer and never as a UTF-8 string. express.raw() with
// type "*/*" only engages when the device sends a Content-Type; if a device
// variant omits it the body is not parsed, so it is drained here instead. The
// drained stream is discarded, never decoded.
function readRawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body, "utf8");
  if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
    // express.json() ran first (device sent application/json). Re-encode
    // defensively so the envelope can still be extracted.
    try {
      return Buffer.from(JSON.stringify(req.body), "utf8");
    } catch {
      return Buffer.alloc(0);
    }
  }
  if (typeof req.resume === "function") req.resume();
  return Buffer.alloc(0);
}

async function touchScanner(scanner) {
  try {
    const lastSeen = scanner.lastSeen instanceof Date ? scanner.lastSeen.getTime() : 0;
    if (Date.now() - lastSeen < SCANNER_TOUCH_THROTTLE_MS) return;

    if (scanner.status === "offline") scanner.status = "online";
    scanner.lastSeen = new Date();
    scanner.lastEventAt = scanner.lastSeen;
    await scanner.save();
  } catch (err) {
    warn(`[FKWEB] scanner liveness update failed: ${err && err.message ? err.message : err}`);
  }
}

async function handleRealtimeGlog({ res, scanner, body, meta }) {
  const envelope = extractJsonObject(body);

  if (!envelope) {
    warn(`[FKWEB] request_code=realtime_glog dev_id=${meta.devId} bodyBytes=${body.length} action=rejected reason=unparseable_body`);
    return sendFkWebAck(res);
  }

  const built = toFkWebScannerEvent(envelope, scanner);
  if (built.error) {
    warn(`[FKWEB] request_code=realtime_glog dev_id=${meta.devId} user_id=${envelope.user_id === undefined ? "-" : envelope.user_id} action=rejected reason=${built.error}`);
    return sendFkWebAck(res);
  }

  const { event, ioMode, verifyMode } = built;

  log(`[FKWEB] request_code=realtime_glog dev_id=${meta.devId} user_id=${event.rawUserId} io_mode=${ioMode} verify_mode=${verifyMode} trans_id=${meta.transId || "-"}`);

  let result;
  try {
    // The single shared attendance pipeline. Unmodified. It performs the
    // duplicate gate, member resolution, branch isolation and eligibility check.
    result = await processScannerEvent({ scanner, event });
  } catch (err) {
    // Never surface this to the device and never let it escape: an escaping
    // rejection would become a 5xx and trigger a device retry.
    error(`[FKWEB] processing error deviceEventId=${event.deviceEventId}: ${err && err.message ? err.message : err}`);
    return sendFkWebAck(res);
  }

  const accepted = result.status === "checkin" || result.status === "checkout";
  log(
    `[FKWEB] scanner=${scanner._id} branch=${scanner.branchCode} user_id=${event.rawUserId} ` +
    `-> attendance ${accepted ? "accepted" : "rejected"} status=${result.status} reason=${result.reason || "-"}`
  );

  await touchScanner(scanner);

  return sendFkWebAck(res);
}

const handleFkWeb = asyncHandler(async (req, res) => {
  const meta = readFkWebRequestMeta(req);
  const body = readRawBody(req);

  if (!meta.requestCode) {
    warn(`[FKWEB] missing request_code method=${req.method} path=${req.path} bodyBytes=${body.length} action=ignored`);
    return sendFkWebAck(res);
  }

  if (!meta.devId) {
    warn(`[FKWEB] request_code=${meta.requestCode} missing dev_id action=ignored`);
    return sendFkWebAck(res);
  }

  if (meta.requestCode !== "realtime_glog" &&
      meta.requestCode !== "receive_cmd" &&
      meta.requestCode !== "send_cmd_result" &&
      meta.requestCode !== "realtime_enroll_data") {
    warn(`[FKWEB] request_code=${meta.requestCode} dev_id=${meta.devId} action=unknown_ack`);
    return sendFkWebAck(res);
  }

  let scanner;
  try {
    scanner = await findScannerByDevId(meta.devId);
  } catch (err) {
    error(`[FKWEB] scanner lookup failed dev_id=${meta.devId}: ${err && err.message ? err.message : err}`);
    return sendFkWebAck(res);
  }

  if (!scanner) {
    warn(`[FKWEB] request_code=${meta.requestCode} dev_id=${meta.devId} scanner=UNREGISTERED action=ignored`);
    return sendFkWebAck(res);
  }

  if (scanner.status === "disabled") {
    warn(`[FKWEB] request_code=${meta.requestCode} dev_id=${meta.devId} scanner=${scanner._id} status=disabled action=ignored`);
    return sendFkWebAck(res);
  }

  log(`[FKWEB] request_code=${meta.requestCode} dev_id=${meta.devId} scanner=${scanner._id} branch=${scanner.branchCode} trans_id=${meta.transId || "-"} blk_no=${meta.blkNo || "-"} bodyBytes=${body.length}`);

  switch (meta.requestCode) {
    case "realtime_glog":
      return handleRealtimeGlog({ res, scanner, body, meta });

    // FkWeb device-command transport is intentionally not implemented. The K30
    // DeviceCommand queue speaks a different, incompatible text protocol
    // ("C:<id>:<command>" / "SET OPTIONS ..."), so it is never reused here.
    case "receive_cmd":
    case "send_cmd_result":
      log(`[FKWEB] request_code=${meta.requestCode} scanner=${scanner._id} action=ack_only device_command_transport=not_implemented`);
      return sendFkWebAck(res);

    // Enrollment sync is out of scope for this iteration. No templates are
    // stored, no Member.biometrics fields are written, and the fingerprint
    // binary tail is never decoded or logged. Only the byte count is recorded.
    case "realtime_enroll_data":
      log(`[FKWEB] request_code=realtime_enroll_data scanner=${scanner._id} bodyBytes=${body.length} action=ack_only enrollment_sync=not_implemented template_data=not_stored`);
      return sendFkWebAck(res);

    default:
      warn(`[FKWEB] request_code=${meta.requestCode} dev_id=${meta.devId} action=unknown_ack`);
      return sendFkWebAck(res);
  }
});

/**
 * Route-level error handler.
 *
 * Mounted after handleFkWeb inside the same route so that body-parser failures
 * (oversized body, truncated Content-Length, socket closed mid-transfer) are
 * converted into a well-formed FkWeb ACK rather than Express's default 400/413
 * HTML. The device must always receive the protocol response it expects.
 * Stack traces are never exposed.
 */
const fkwebErrorHandler = (err, _req, res, next) => {
  if (res.headersSent) return next(err);
  const type = err && err.type ? err.type : "unknown";
  const status = err && err.statusCode ? err.statusCode : 500;
  warn(`[FKWEB] body rejected type=${type} status=${status}; acknowledging device`);
  return sendFkWebAck(res);
};

module.exports = { handleFkWeb, fkwebErrorHandler, sendFkWebAck, ACK_HEADERS };
