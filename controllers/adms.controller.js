const { AppError } = require("../utils/appError");
const { findScannerBySerial, normalizeSerial } = require("../services/admsDeviceLookup");
const { parseAttLog, toScannerEvent } = require("../utils/admsParser");
const { processScannerEvent } = require("../services/scanner.service");
const { buildGetRequestResponse, buildCdataResponse } = require("../utils/admsResponse");
const {
  dequeuePendingCommand,
  acknowledgeCommand,
  enqueueRestrictionCommand
} = require("../services/deviceCommand.service");

function extractSerial(url) {
  const raw = url.searchParams.get("SN") || "";
  return normalizeSerial(raw.split(";")[0]);
}

async function resolveScanner(url) {
  const serial = extractSerial(url);
  if (!serial) throw new AppError("Missing SN query parameter", 400);
  const scanner = await findScannerBySerial(serial);
  if (!scanner) throw new AppError("Scanner not registered", 404);
  if (scanner.status === "disabled") throw new AppError("Scanner is disabled", 403);
  return scanner;
}

function sendText(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain");
  res.end(body);
}

// ZKTeco/eSSL firmware can wrap an ATTLOG stream in a URL-encoded form-key body
// (e.g. "table=ATTLOG&data=2026-09-20%2008:05:12%2C1001%2C...") instead of raw
// text. Normalize that shape back to raw log lines for the parser while passing
// genuine raw streams through untouched.
function normalizeCdataPayload(rawBody) {
  const text = String(rawBody === undefined || rawBody === null ? "" : rawBody);
  if (!text) return text;

  let decoded = text;
  if (text.includes("%")) {
    try {
      decoded = decodeURIComponent(text);
    } catch {
      decoded = text;
    }
  }

  if (!decoded.includes("=")) return decoded;

  const params = new URLSearchParams(decoded);
  for (const key of ["data", "Data", "DATA", "logs", "Logs", "attLog", "ATTLOG", "attlog"]) {
    const value = params.get(key);
    if (value) return value;
  }

  const lastAmp = decoded.lastIndexOf("&");
  const tail = lastAmp === -1 ? decoded : decoded.slice(lastAmp + 1);
  const firstEq = tail.indexOf("=");
  if (firstEq !== -1) {
    const stripped = tail.slice(firstEq + 1);
    if (stripped.trim()) return stripped;
  }

  return decoded;
}

async function handleGetRequest(req, res, url) {
  const scanner = await resolveScanner(url);
  scanner.lastSeen = new Date();
  await scanner.save();

  let command = null;
  try {
    command = await dequeuePendingCommand(scanner.serial);
  } catch (err) {
    console.error(`[adms] getrequest queue error for ${scanner.serial}:`, err && err.message ? err.message : err);
  }

  sendText(res, 200, buildGetRequestResponse(command));
}

async function handleCdata(req, res, url, body) {
  const scanner = await resolveScanner(url);
  const table = (url.searchParams.get("table") || "ATTLOG").toUpperCase();
  const timezone = scanner.deviceTimezone;

  if (table === "ATTLOG") {
    scanner.status = "online";
    scanner.lastSeen = new Date();
    scanner.lastEventAt = new Date();
    await scanner.save();

    let payload = normalizeCdataPayload(body);
    if (!payload || !payload.trim()) {
      // A plain GET push carries no request body; fall back to log strings embedded
      // in the raw query tracking values when available
      const queryLog =
        url.searchParams.get("data") ||
        url.searchParams.get("logs") ||
        url.searchParams.get("attLog") ||
        url.searchParams.get("ATTLOG");
      payload = normalizeCdataPayload(queryLog || "");
    }
    if (!payload || !payload.trim()) {
      sendText(res, 200, "OK\n");
      return;
    }

    const records = parseAttLog(payload, timezone);
    const results = [];
    for (const record of records) {
      if (record.malformed) continue;
      const event = toScannerEvent(record, scanner);
      if (!event) continue;
      const result = await processScannerEvent({ scanner, event });
      results.push({ status: result.status, reason: result.reason || null });

      if (result.status === "denied" && result.reason) {
        await enqueueRestrictionCommand(scanner, result.reason);
      }
    }

    sendText(res, 200, buildCdataResponse(results));
    return;
  }

  scanner.lastSeen = new Date();
  await scanner.save();
  sendText(res, 200, buildCdataResponse([]));
}

async function handleDeviceCmd(req, res, url, body) {
  const serial = extractSerial(url);
  const payload = String(body || "").trim();
  const params = new URLSearchParams(payload);

  const commandId = Number(params.get("ID"));
  const returnCode = params.get("Return");

  if (!Number.isInteger(commandId) || commandId <= 0) {
    sendText(res, 400, "Bad Request");
    return;
  }

  try {
    await acknowledgeCommand({
      serialNumber: serial || undefined,
      commandId,
      returnCode,
      rawBody: payload
    });
  } catch (err) {
    console.error(`[adms] devicecmd acknowledge error:`, err && err.message ? err.message : err);
  }

  sendText(res, 200, "OK");
}

module.exports = { handleGetRequest, handleCdata, handleDeviceCmd, extractSerial, resolveScanner };