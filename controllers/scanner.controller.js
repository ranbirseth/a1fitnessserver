const Scanner = require("../models/scanner.model");
const Member = require("../models/member.model");
const { asyncHandler } = require("../utils/asyncHandler");
const { sendResponse } = require("../utils/response");
const { AppError } = require("../utils/appError");
const { enforceBranchOwnership } = require("../middlewares/branchScope.middleware");
const { hashKey, generateKey } = require("../utils/deviceKey");

const findScannedById = async (req) => {
  const scanner = await Scanner.findOne({ _id: req.params.id, gymId: req.gymId });
  if (!scanner) throw new AppError("Scanner not found", 404);
  if (!enforceBranchOwnership(scanner.branchCode, req)) {
    throw new AppError("Scanner not found in your branch", 404);
  }
  return scanner;
};

const assertAdminWrite = (req) => {
  if (!req.user || req.user.role !== "admin") {
    throw new AppError("Forbidden: Only branch admins can manage scanners", 403);
  }
};

const getScanners = asyncHandler(async (req, res) => {
  const query = { gymId: req.gymId };
  if (!req.user || req.user.role !== "superadmin") {
    query.branchCode = (req.user.branchCode || "MAIN").trim().toUpperCase();
  } else if (req.query.branchCode && req.query.branchCode !== "ALL" && req.query.branchCode !== "all") {
    query.branchCode = req.query.branchCode.trim().toUpperCase();
  }

  const items = await Scanner.find(query).select("-apiKeyHash").sort({ createdAt: -1 });
  sendResponse(res, { message: "Scanners fetched", data: items });
});

const createScanner = asyncHandler(async (req, res) => {
  assertAdminWrite(req);

  const { name, deviceId } = req.body;
  if (!name || !deviceId) throw new AppError("name and deviceId are required", 400);

  const existing = await Scanner.findOne({ deviceId });
  if (existing) throw new AppError("A scanner with this deviceId already exists", 409);

  const requestedBranch = typeof req.body.branchCode === "string" && req.body.branchCode.trim()
    ? req.body.branchCode.trim().toUpperCase()
    : "";
  if (requestedBranch && !enforceBranchOwnership(requestedBranch, req)) {
    throw new AppError("Forbidden: Cannot assign a scanner to another branch", 403);
  }
  const branchCode = requestedBranch || (req.user.branchCode || "MAIN").trim().toUpperCase();

  const apiKey = generateKey();
  const body = { ...req.body };
  delete body.apiKey;
  delete body.apiKeyHash;
  delete body.gymId;
  delete body.branchCode;

  const scanner = await Scanner.create({
    gymId: req.gymId,
    branchCode,
    name,
    deviceId,
    createdBy: req.user._id,
    ...body,
    apiKeyHash: hashKey(apiKey)
  });

  sendResponse(res, {
    status: 201,
    message: "Scanner created. Save the API key now - it will not be shown again.",
    data: { ...scanner.toObject(), apiKey }
  });
});

const getScannerById = asyncHandler(async (req, res) => {
  const scanner = await findScannedById(req);
  sendResponse(res, { message: "Scanner fetched", data: scanner });
});

const updateScanner = asyncHandler(async (req, res) => {
  assertAdminWrite(req);

  const scanner = await findScannedById(req);

  const allowed = ["name", "brand", "model", "serial", "ipAddress", "port", "deviceTimezone", "protocol", "type", "status", "gates", "settings"];
  const updates = {};
  allowed.forEach((field) => {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  });

  Object.assign(scanner, updates);
  if (updates.status && updates.status !== "disabled") {
    scanner.lastSeen = new Date();
  }
  await scanner.save();
  sendResponse(res, { message: "Scanner updated", data: scanner });
});

const deleteScanner = asyncHandler(async (req, res) => {
  assertAdminWrite(req);

  const scanner = await findScannedById(req);
  scanner.status = "disabled";
  await scanner.save();
  sendResponse(res, { message: "Scanner disabled. Event history is preserved.", data: scanner });
});

const rotateScannerKey = asyncHandler(async (req, res) => {
  assertAdminWrite(req);

  const scanner = await findScannedById(req);
  const apiKey = generateKey();
  scanner.apiKeyHash = hashKey(apiKey);
  await scanner.save();
  sendResponse(res, {
    message: "Scanner API key rotated. Configure the device with the new key.",
    data: { apiKey }
  });
});

const getSyncPayload = asyncHandler(async (req, res) => {
  assertAdminWrite(req);

  const scanner = await findScannedById(req);
  const members = await Member.find({ gymId: req.gymId, branchCode: scanner.branchCode })
    .populate({ path: "user", select: "name" })
    .lean();

  const now = Date.now();
  const payload = members.map((m) => ({
    memberId: m._id,
    name: m.user?.name || "",
    secretCode: m.secretCode || "",
    deviceUserId: m.biometrics?.deviceUserId || "",
    cardId: m.biometrics?.cardId || "",
    active:
      m.status === "active" &&
      m.paymentStatus === "paid" &&
      (!m.membershipExpiryDate || new Date(m.membershipExpiryDate) > now),
    membershipExpiryDate: m.membershipExpiryDate,
    fingerprintCount: m.biometrics?.fingerprints?.length || 0
  }));

  scanner.lastSync = new Date();
  await scanner.save();

  sendResponse(res, {
    message: "Sync payload generated for device enrollment",
    data: { scanner: scanner.deviceId, count: payload.length, members: payload }
  });
});

const pingScanner = asyncHandler(async (req, res) => {
  const scanner = await findScannedById(req);

  const thresholdMs = Number(process.env.SCANNER_OFFLINE_AFTER_MS || 30000);
  const lastSeen = scanner.lastSeen instanceof Date ? scanner.lastSeen : null;
  const ageMs = lastSeen ? Date.now() - lastSeen.getTime() : null;
  const status = lastSeen && ageMs !== null && ageMs < thresholdMs ? "online" : "offline";

  sendResponse(res, {
    message: `Scanner reported ${status}`,
    data: {
      scannerId: scanner._id,
      deviceId: scanner.deviceId,
      serial: scanner.serial || null,
      branchCode: scanner.branchCode || "MAIN",
      status,
      lastSeen: lastSeen ? lastSeen.toISOString() : null,
      ageMs,
      thresholdMs
    }
  });
});

module.exports = {
  getScanners,
  createScanner,
  getScannerById,
  updateScanner,
  deleteScanner,
  rotateScannerKey,
  getSyncPayload,
  pingScanner
};