// ============================================================
// FkWeb PROTOCOL PARSER (realtime Biometric RS9n)
//
// Pure, side-effect free helpers. This file NEVER imports from
// utils/admsParser.js except for the read-only `normalizeUserId` pure function,
// which is the exact same helper services/scanner.service.js already uses when
// building its member-lookup candidate list. Reusing it guarantees the RS9n
// user_id is normalized identically to the K30 user id, so member resolution
// cannot silently diverge between the two protocols. Nothing in the K30 file is
// modified by this import.
//
// The RS9n speaks a completely different wire format from the eSSL K30:
//   K30  : tab/comma text lines under /iclock/*, ISO-8601 dates
//   RS9n : HTTP/1.0 absolute-form POST, JSON envelope + optional binary tail,
//          compact YYYYMMDDHHMMSS timestamps
// The two parsers are intentionally NOT merged.
// ============================================================

const { fromZonedTime } = require("date-fns-tz");
const { DEFAULT_TIMEZONE } = require("./date");
const { normalizeUserId } = require("./admsParser");

// Compact FkWeb timestamp: "20260930111551" => YYYYMMDDHHMMSS (14 chars).
const FKWEB_IO_TIME_PATTERN = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/;

// A realtime_glog envelope is ~105 bytes. 4 KiB is a generous ceiling that still
// bounds the work done on a hostile or corrupt frame: the scan is a single
// bounded pass over at most this many bytes, never over the whole body. A
// realtime_enroll_data envelope with many users can legitimately exceed it, but
// enroll data is intentionally never parsed (see the controller).
const MAX_JSON_SCAN_BYTES = 4096;

const CHAR_OPEN_BRACE = 0x7b; // {
const CHAR_CLOSE_BRACE = 0x7d; // }
const CHAR_QUOTE = 0x22; // "
const CHAR_BACKSLASH = 0x5c; // \

// Header names arrive lowercased from Node's HTTP parser. Underscore headers are
// legal in HTTP/1.1 (they are valid tchar), but intermediate proxies are known
// to rewrite them to dashes or drop them entirely, so several spellings are
// accepted and a normalized fallback is used as a last resort.
const REQUEST_CODE_HEADERS = ["request_code", "request-code", "x-request-code", "requestcode"];
const DEV_ID_HEADERS = ["dev_id", "dev-id", "x-dev-id", "devid"];
const TRANS_ID_HEADERS = ["trans_id", "trans-id", "x-trans-id", "transid"];
const BLK_NO_HEADERS = ["blk_no", "blk-no", "x-blk-no", "blkno"];

// Only values that exist in the ScannerEvent.eventType / Attendance.eventType
// enums may ever be produced. Anything unrecognised falls back to
// "fingerprint" so an unexpected verify_mode can never trigger a Mongoose
// ValidationError (which would surface as a 500 and invite a device retry).
const VERIFY_MODE_TO_EVENT_TYPE = {
  1: "fingerprint",
  2: "card",
  3: "card",
  4: "fingerprint",
  5: "fingerprint",
  6: "face",
  7: "fingerprint",
};
const FALLBACK_EVENT_TYPE = "fingerprint";

function resolveTimezone(timezone) {
  if (timezone && typeof timezone === "string" && timezone.trim()) return timezone.trim();
  return DEFAULT_TIMEZONE;
}

function firstNonEmptyString(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed;
}

function normalizeHeaderKey(key) {
  return String(key).toLowerCase().replace(/[-_]/g, "");
}

// Resolves a header defensively: exact aliases first, then a separator-insensitive
// scan so a proxy that rewrote "dev_id" to "dev-id" or "devId" is still matched.
// The query string is checked last because a proxy that mangles headers may also
// have preserved the values there.
function readHeader(req, aliases) {
  const headers = (req && req.headers) || {};

  for (const alias of aliases) {
    const direct = firstNonEmptyString(headers[alias]);
    if (direct) return direct;
  }

  const wanted = new Set(aliases.map(normalizeHeaderKey));
  for (const key of Object.keys(headers)) {
    if (!wanted.has(normalizeHeaderKey(key))) continue;
    const value = firstNonEmptyString(headers[key]);
    if (value) return value;
  }

  const query = (req && req.query) || {};
  for (const alias of aliases) {
    const fromQuery = firstNonEmptyString(query[alias]);
    if (fromQuery) return fromQuery;
  }

  return "";
}

// Reads the four FkWeb request headers that the device transmits.
function readFkWebRequestMeta(req) {
  return {
    requestCode: readHeader(req, REQUEST_CODE_HEADERS),
    devId: readHeader(req, DEV_ID_HEADERS),
    transId: readHeader(req, TRANS_ID_HEADERS),
    blkNo: readHeader(req, BLK_NO_HEADERS),
  };
}

// Only a POST to the FkWeb ingest path may bypass the global rate limiter.
// Deliberately exact (POST + exact path) so that GET / and every /api route stay
// rate limited: the RS9n replays buffered history on connect and would otherwise
// be throttled like a DDoS.
function isFkWebDevicePush(req) {
  if (!req || req.method !== "POST") return false;
  return req.path === "/" || req.path === "/fkweb";
}

/**
 * Extracts the leading JSON envelope from a raw request body WITHOUT decoding the
 * body as UTF-8 text.
 *
 * The body is kept as a Buffer end-to-end. Brace matching is escape-aware and
 * string-aware so a '{' or '}' inside a JSON string value cannot truncate the
 * envelope early, and so an escaped quote cannot desynchronise the scanner. Any
 * failure returns null rather than throwing, which is what makes malformed and
 * binary frames safe.
 *
 * @returns {object|null} the parsed envelope, or null when it cannot be found.
 */
function extractJsonObject(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return null;

  const scanWindow = buf.subarray(0, Math.min(buf.length, MAX_JSON_SCAN_BYTES));
  const start = scanWindow.indexOf(CHAR_OPEN_BRACE);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < scanWindow.length; i++) {
    const ch = scanWindow[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === CHAR_BACKSLASH) {
        escaped = true;
      } else if (ch === CHAR_QUOTE) {
        inString = false;
      }
      continue;
    }

    if (ch === CHAR_QUOTE) {
      inString = true;
    } else if (ch === CHAR_OPEN_BRACE) {
      depth++;
    } else if (ch === CHAR_CLOSE_BRACE) {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(scanWindow.subarray(start, i + 1).toString("utf8"));
          return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }

  // No balanced terminator inside the scan window.
  return null;
}

/**
 * Parses the compact FkWeb io_time ("20260930111551") into an absolute Date.
 * The wall-clock reading is interpreted in the registered Scanner's
 * deviceTimezone, matching how the ADMS parser treats device-local timestamps.
 *
 * @returns {Date|null} null when the value is absent or not a valid timestamp.
 */
function parseFkWebIoTime(value, timezone) {
  const text = value === undefined || value === null ? "" : String(value).trim();
  if (!text) return null;

  const match = text.match(FKWEB_IO_TIME_PATTERN);
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  const wallClock = `${year}-${month}-${day}T${hour}:${minute}:${second}`;

  try {
    const date = fromZonedTime(wallClock, resolveTimezone(timezone));
    return Number.isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}

function mapVerifyModeToEventType(verifyMode) {
  const key = verifyMode === undefined || verifyMode === null ? "" : String(verifyMode).trim();
  return VERIFY_MODE_TO_EVENT_TYPE[key] || FALLBACK_EVENT_TYPE;
}

/**
 * Builds a deterministic deviceEventId for a realtime_glog record.
 *
 * Every component is derived from the registered Scanner document or from the
 * values the device itself reported, and NEVER from request arrival time. A
 * device retry therefore produces a byte-identical id, which is what makes
 * processScannerEvent()'s ScannerEvent duplicate gate (scanner.service.js:139)
 * and the unique deviceEventId index collapse the retry into a no-op instead of
 * a second attendance row.
 */
function makeFkWebDeviceEventId({ scanner, userId, ioTimeRaw, timestamp, ioMode, verifyMode }) {
  const identity = (scanner && (scanner.serial || scanner.deviceId)) || "unknown";
  const timeMs = timestamp instanceof Date ? timestamp.getTime() : 0;
  return [
    identity,
    userId === undefined || userId === null ? "" : String(userId).trim(),
    timeMs,
    ioMode === undefined || ioMode === null || String(ioMode).trim() === "" ? "0" : String(ioMode).trim(),
    verifyMode === undefined || verifyMode === null || String(verifyMode).trim() === "" ? "0" : String(verifyMode).trim(),
    ioTimeRaw === undefined || ioTimeRaw === null ? "" : String(ioTimeRaw).trim()
  ].join(":");
}

/**
 * Converts a decoded realtime_glog envelope into the normalized event shape that
 * processScannerEvent({ scanner, event }) already consumes.
 *
 * rawUserId carries the original zero-padded value ("00000258"). resolveMember()
 * builds its candidate list as [normalizeUserId(userId), rawUserId, userId], and
 * Member.biometrics.deviceUserId is stored verbatim by linkBiometric() with no
 * padding normalisation. Supplying rawUserId is therefore what lets a
 * zero-padded stored value match.
 *
 * @returns {{event: object, ioTimeRaw: string, ioMode: *, verifyMode: *}|{error: string}}
 */
function toFkWebScannerEvent(record, scanner) {
  if (!record || typeof record !== "object") return { error: "unparseable_body" };

  const rawUserId = record.user_id === undefined || record.user_id === null ? "" : String(record.user_id).trim();
  if (!rawUserId) return { error: "missing_user_id" };

  const ioTimeRaw = record.io_time === undefined || record.io_time === null ? "" : String(record.io_time).trim();
  const timestamp = parseFkWebIoTime(ioTimeRaw, scanner && scanner.deviceTimezone);
  if (!timestamp) return { error: "invalid_io_time" };

  const ioMode = record.io_mode;
  const verifyMode = record.verify_mode;

  return {
    ioTimeRaw,
    ioMode,
    verifyMode,
    event: {
      userId: normalizeUserId(rawUserId),
      rawUserId,
      timestamp,
      verified: true,
      eventType: mapVerifyModeToEventType(verifyMode),
      deviceEventId: makeFkWebDeviceEventId({
        scanner,
        userId: rawUserId,
        ioTimeRaw,
        timestamp,
        ioMode,
        verifyMode
      })
    }
  };
}

module.exports = {
  FKWEB_IO_TIME_PATTERN,
  MAX_JSON_SCAN_BYTES,
  FALLBACK_EVENT_TYPE,
  VERIFY_MODE_TO_EVENT_TYPE,
  REQUEST_CODE_HEADERS,
  DEV_ID_HEADERS,
  TRANS_ID_HEADERS,
  BLK_NO_HEADERS,
  isFkWebDevicePush,
  readFkWebRequestMeta,
  readHeader,
  extractJsonObject,
  parseFkWebIoTime,
  mapVerifyModeToEventType,
  makeFkWebDeviceEventId,
  toFkWebScannerEvent
};
