const { fromZonedTime } = require("date-fns-tz");
const { DEFAULT_TIMEZONE } = require("./date");

const VERIFY_TYPE_TO_EVENT = {
  "1": "fingerprint",
  "2": "card",
  "3": "pin",
  "4": "face"
};

const FALLBACK_EVENT_TYPE = "fingerprint";

const ADMS_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/;

function normalizeUserId(value) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  if (!text) return text;
  if (/^\d+$/.test(text)) {
    const stripped = text.replace(/^0+/, "");
    return stripped.length > 0 ? stripped : "0";
  }
  return text;
}

function resolveTimezone(timezone) {
  if (timezone && typeof timezone === "string" && timezone.trim()) return timezone.trim();
  return DEFAULT_TIMEZONE;
}

function mapVerifyTypeToEventType(verifyType) {
  const key = verifyType === undefined || verifyType === null ? "" : String(verifyType).trim();
  return VERIFY_TYPE_TO_EVENT[key] || FALLBACK_EVENT_TYPE;
}

function parseAdmsDateTime(value, timezone) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  const match = text.match(ADMS_DATETIME_PATTERN);
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

function parseAttLog(body, timezone) {
  const lines = String(body === undefined || body === null ? "" : body).split(/\r?\n/);
  const records = [];
  for (const line of lines) {
    const raw = line.trim();
    if (!raw) continue;
    // Support both comma-split and tab-separated hardware stream layouts seamlessly
    const columns = raw.split(/[\t,]+/);
    // Correct field index mapping to match live eSSL K30+ID hardware payloads
    const userId = (columns[0] || "").trim();
    const dateTime = (columns[1] || "").trim();
    const timestamp = parseAdmsDateTime(dateTime, timezone);
    if (!dateTime || !userId || !timestamp) {
      records.push({ raw, malformed: true });
      continue;
    }
    records.push({
      userId,
      timestamp,
      verifyType: columns[2] !== undefined ? columns[2].trim() : undefined,
      attState: columns[3] !== undefined ? columns[3].trim() : undefined,
      verifyResult: columns[4] !== undefined ? columns[4].trim() : undefined,
      workCode: columns[5] !== undefined ? columns[5].trim() : undefined,
      reserved: columns.length > 6 ? columns.slice(6).join(",").trim() : undefined,
      raw
    });
  }
  return records;
}

function makeDeviceEventId(scanner, record) {
  const identity = scanner.serial || scanner.deviceId || "unknown";
  const timeMs = record.timestamp instanceof Date ? record.timestamp.getTime() : 0;
  return [
    identity,
    record.userId,
    timeMs,
    record.attState || "0",
    record.verifyType || "0",
    record.workCode || "0"
  ].join(":");
}

function toScannerEvent(record, scanner) {
  if (!record || record.malformed || !record.timestamp || !record.userId) return null;
  const eventType = mapVerifyTypeToEventType(record.verifyType);
  const isCard = String(record.verifyType) === "2";
  const event = {
    userId: normalizeUserId(record.userId),
    rawUserId: String(record.userId).trim(),
    timestamp: record.timestamp,
    verified: true,
    deviceEventId: makeDeviceEventId(scanner, record),
    eventType
  };
  if (isCard && event.userId) {
    event.cardId = event.userId;
    event.rawCardId = event.rawUserId;
  }
  return event;
}

module.exports = {
  parseAttLog,
  toScannerEvent,
  mapVerifyTypeToEventType,
  parseAdmsDateTime,
  makeDeviceEventId,
  normalizeUserId,
  resolveTimezone,
  VERIFY_TYPE_TO_EVENT,
  FALLBACK_EVENT_TYPE
};