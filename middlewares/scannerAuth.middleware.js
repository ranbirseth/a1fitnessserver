const Scanner = require("../models/scanner.model");
const { hashKey } = require("../utils/deviceKey");

const authenticateDevice = async (req, res, next) => {
  const deviceId = req.headers["x-scanner-id"] || req.body?.deviceId;
  const headerKey = req.headers["x-scanner-key"] || req.body?.apiKey;
  const pushSecret = req.headers["x-push-secret"];

  if (!deviceId) {
    return res.status(401).json({ success: false, message: "Missing x-scanner-id header" });
  }

  const scanner = await Scanner.findOne({ deviceId });
  if (!scanner) {
    return res.status(404).json({ success: false, message: "Scanner not registered" });
  }
  if (scanner.status === "disabled") {
    return res.status(403).json({ success: false, message: "Scanner is disabled" });
  }

  if (pushSecret && process.env.DEVICE_PUSH_SECRET && pushSecret === process.env.DEVICE_PUSH_SECRET) {
    req.scanner = scanner;
    return next();
  }

  if (headerKey && scanner.apiKeyHash && scanner.apiKeyHash === hashKey(headerKey)) {
    req.scanner = scanner;
    return next();
  }

  return res.status(401).json({ success: false, message: "Invalid scanner credentials" });
};

module.exports = { authenticateDevice };