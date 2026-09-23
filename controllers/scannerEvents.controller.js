const { asyncHandler } = require("../utils/asyncHandler");
const { sendResponse } = require("../utils/response");
const { AppError } = require("../utils/appError");
const { processScannerEvent } = require("../services/scanner.service");

const ingestEvents = asyncHandler(async (req, res) => {
  const scanner = req.scanner;
  const source = Array.isArray(req.body) ? req.body : (req.body.events || req.body.transactions || []);
  if (!Array.isArray(source)) throw new AppError("events (or body array) is required", 400);

  scanner.status = "online";
  scanner.lastSeen = new Date();
  scanner.lastEventAt = new Date();
  await scanner.save();

  const counts = { received: source.length, checkin: 0, checkout: 0, denied: 0, duplicate: 0 };
  const summaries = [];

  for (const event of source) {
    const result = await processScannerEvent({ scanner, event });
    if (result.status === "checkin") counts.checkin++;
    else if (result.status === "checkout") counts.checkout++;
    else if (result.status === "duplicate") counts.duplicate++;
    else counts.denied++;
    summaries.push({ status: result.status, reason: result.reason || null });
  }

  sendResponse(res, {
    status: 202,
    message: "Events processed",
    data: { scanner: scanner.deviceId, counts, events: summaries }
  });
});

const heartbeat = asyncHandler(async (req, res) => {
  const scanner = req.scanner;
  const requested = req.body.status;
  scanner.status = requested === "maintenance" || requested === "disabled" ? requested : "online";
  scanner.lastSeen = new Date();
  await scanner.save();
  sendResponse(res, { message: "Heartbeat received" });
});

module.exports = { ingestEvents, heartbeat };