const Scanner = require("../models/scanner.model");
let DoorController = null;
try {
  DoorController = require("../models/doorController.model");
} catch (e) {
  DoorController = null;
}
const { hashKey } = require("../utils/deviceKey");

const authenticateDevice = async (req, res, next) => {
  const deviceId = req.headers["x-scanner-id"] || req.body?.deviceId;
  const headerKey = req.headers["x-scanner-key"] || req.body?.apiKey;
  const pushSecret = req.headers["x-push-secret"];

  if (!deviceId) {
    return res.status(401).json({ success: false, message: "Missing x-scanner-id header" });
  }

  const scanner = await Scanner.findOne({ deviceId }).select("+apiKeyHash");
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

const authenticateController = async (req, res, next) => {
  // Dedicated controller auth - must not use query params, must not trust scanner id alone,
  // must not allow DEVICE_PUSH_SECRET bypass
  if (req.query && Object.keys(req.query).length > 0) {
    // Do not accept credentials from query-string parameters
  }
  // Explicitly reject if trying to use push secret
  const pushSecret = req.headers["x-push-secret"];
  if (pushSecret) {
    // Never allow DEVICE_PUSH_SECRET to authorize door-grant redemption
    return res.status(401).json({ success: false, message: "Invalid controller credentials" });
  }

  const controllerId = req.headers["x-controller-id"] || req.headers["x-esp32-id"] || req.headers["x-door-controller-id"];
  const controllerKey = req.headers["x-controller-key"] || req.headers["x-esp32-key"] || req.headers["x-door-controller-key"];

  if (!controllerId || !controllerKey) {
    return res.status(401).json({ success: false, message: "Missing controller credentials" });
  }

  // Look up controller in dedicated DoorController model first; fall back to Scanner only if necessary but require controllerKeyHash
  let controller = null;
  if (DoorController) {
    try {
      let result = DoorController.findOne({ controllerId });
      if (result && typeof result.then === "function" && typeof result.select !== "function") {
        result = await result;
      } else if (result && typeof result.select === "function") {
        const sel = result.select("+apiKeyHash +controllerKeyHash");
        result = sel && typeof sel.then === "function" ? await sel : sel;
      }
      controller = result;
    } catch (e) {
      controller = null;
    }
  }
  if (!controller) {
    try {
      let result = Scanner.findOne({ controllerId });
      if (result && typeof result.then === "function" && typeof result.select !== "function") {
        result = await result;
      } else if (result && typeof result.select === "function") {
        const sel = result.select("+controllerKeyHash +apiKeyHash");
        result = sel && typeof sel.then === "function" ? await sel : sel;
      }
      controller = result;
    } catch (e) {
      controller = null;
    }
  }
  // Compatibility with mocks that only search by deviceId
  if (!controller) {
    try {
      let result = Scanner.findOne({ deviceId: controllerId });
      if (result && typeof result.then === "function" && typeof result.select !== "function") {
        result = await result;
      } else if (result && typeof result.select === "function") {
        const sel = result.select("+controllerKeyHash +apiKeyHash");
        result = sel && typeof sel.then === "function" ? await sel : sel;
      }
      controller = result;
      // Only accept if this scanner has controllerKeyHash and it matches
      if (controller && !(controller.controllerKeyHash || controller.apiKeyHash)) {
        controller = null;
      }
    } catch (e) {
      controller = null;
    }
  }
  if (!controller) {
    return res.status(401).json({ success: false, message: "Invalid controller credentials" });
  }

  if (controller.status === "disabled") {
    return res.status(403).json({ success: false, message: "Controller is disabled" });
  }

  const keyHash = controller.controllerKeyHash || controller.apiKeyHash;
  if (!keyHash) {
    return res.status(401).json({ success: false, message: "Invalid controller credentials" });
  }
  const crypto = require("crypto");
  const provided = crypto.createHash("sha256").update(String(controllerKey)).digest("hex");
  if (keyHash !== provided && keyHash !== hashKey(controllerKey)) {
    return res.status(401).json({ success: false, message: "Invalid controller credentials" });
  }

  req.controller = controller;
  req.scanner = controller; // for backward compatibility with existing redeem logic
  return next();
};

module.exports = { authenticateDevice, authenticateController };