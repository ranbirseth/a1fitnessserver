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

module.exports = { getTodayDate, formatDateInTimezone, DEFAULT_TIMEZONE };