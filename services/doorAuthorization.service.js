const crypto = require("crypto");
const DoorAuthorization = require("../models/doorAuthorization.model");

const DEFAULT_TTL_SECONDS = 15;

function getAuthorizationTtlMs() {
  const parsed = Number.parseInt(process.env.DOOR_AUTHORIZATION_TTL_SECONDS || "", 10);
  const seconds = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_SECONDS;
  return seconds * 1000;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

/**
 * Issues a short-lived, scanner-bound, single-use authorization. The raw token
 * is returned exactly once to the caller and only its SHA-256 hash is stored.
 * A caller must not log the raw token.
 */
async function issueDoorAuthorization({ scanner, member, attendance, scannerEvent, now = new Date() }) {
  if (!scanner || !scanner._id || !scanner.gymId || !member || !member._id || !attendance || !attendance._id || !scannerEvent || !scannerEvent._id) {
    return null;
  }

  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(now.getTime() + getAuthorizationTtlMs());

  const authorization = await DoorAuthorization.create({
    gymId: scanner.gymId,
    branchCode: scanner.branchCode || "MAIN",
    scanner: scanner._id,
    deviceId: scanner.deviceId,
    member: member._id,
    attendance: attendance._id,
    scannerEvent: scannerEvent._id,
    tokenHash,
    status: "pending",
    expiresAt
  });

  return {
    id: authorization._id,
    token,
    expiresAt
  };
}

/**
 * Atomically consumes a token. The query is bound to the authenticated controller/scanner,
 * gym and branch; a token from another device cannot be redeemed. The
 * findOneAndUpdate is the replay barrier: only one caller can flip pending ->
 * consumed.
 */
async function redeemDoorAuthorization({ scanner, token, controller, now = new Date() }) {
  const authContext = controller || scanner;
  if (!authContext || !authContext._id || !authContext.gymId || !token) {
    return { authorized: false, reason: "invalid_request" };
  }

  const filter = {
    tokenHash: hashToken(token),
    gymId: authContext.gymId,
    branchCode: authContext.branchCode || "MAIN",
    status: "pending",
    expiresAt: { $gt: now }
  };

  if (controller) {
    // Controllers redeem grants; ensure strict binding to same gym/branch
    // If controller has allowed scanner restrictions, enforce if present
    if (Array.isArray(controller.allowedScanners) && controller.allowedScanners.length > 0) {
      filter.scanner = { $in: controller.allowedScanners };
    } else if (Array.isArray(controller.allowedScannerIds) && controller.allowedScannerIds.length > 0) {
      filter.deviceId = { $in: controller.allowedScannerIds };
    } else {
      // No explicit allowed list - bind to the controller's own associated scanner/deviceId
      // This handles DoorController model and Scanner fallback (where controllerId/deviceId identifies the controller)
      if (controller._id) {
        filter.scanner = controller._id;
      }
      if (controller.deviceId) {
        filter.deviceId = controller.deviceId;
      }
    }
  } else if (scanner) {
    filter.scanner = scanner._id;
  } else {
    return { authorized: false, reason: "invalid_request" };
  }

  const authorization = await DoorAuthorization.findOneAndUpdate(
    filter,
    {
      $set: {
        status: "consumed",
        consumedAt: now,
        consumedByController: controller ? controller._id : undefined,
        consumedByScanner: scanner && !controller ? scanner._id : (controller ? undefined : scanner?._id)
      }
    },
    { new: true }
  );

  if (!authorization) {
    return { authorized: false, reason: "invalid_or_expired" };
  }

  if (controller) {
    if (
      String(authorization.gymId) !== String(controller.gymId) ||
      String(authorization.branchCode || "MAIN").toLowerCase() !== String(controller.branchCode || "MAIN").toLowerCase()
    ) {
      try {
        await DoorAuthorization.updateOne({ _id: authorization._id, status: "consumed" }, { $set: { status: "pending" }, $unset: { consumedAt: 1, consumedByController: 1 } });
      } catch (e) {}
      return { authorized: false, reason: "invalid_or_expired" };
    }
  }

  return {
    authorized: true,
    authorizationId: authorization._id,
    expiresAt: authorization.expiresAt
  };
}

module.exports = {
  issueDoorAuthorization,
  redeemDoorAuthorization,
  getAuthorizationTtlMs,
  hashToken
};
