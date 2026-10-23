const { fromZonedTime } = require("date-fns-tz");

const DEFAULT_TIMEZONE = process.env.TIMEZONE || "Asia/Kolkata";

function formatDateInTimezone(dateInput, timezone = DEFAULT_TIMEZONE) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const map = {};
  parts.forEach((p) => {
    if (p.type !== "literal") map[p.type] = p.value;
  });
  return `${map.year}-${map.month}-${map.day}`;
}

const getTodayDate = (timezone = DEFAULT_TIMEZONE) => formatDateInTimezone(new Date(), timezone);

const getStartOfDayInTimezone = (dateInput = new Date(), timezone = DEFAULT_TIMEZONE) => {
  const day = formatDateInTimezone(dateInput, timezone);
  return fromZonedTime(`${day}T00:00:00`, timezone);
};

const getNoonInTimezone = (dateInput, timezone = DEFAULT_TIMEZONE) => {
  const isDateOnly = typeof dateInput === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateInput);
  const day = isDateOnly ? dateInput : formatDateInTimezone(dateInput, timezone);
  return fromZonedTime(`${day}T12:00:00`, timezone);
};

module.exports = { getTodayDate, formatDateInTimezone, getStartOfDayInTimezone, getNoonInTimezone, DEFAULT_TIMEZONE };