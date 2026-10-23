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
 * Atomically consumes a token. The query is bound to the authenticated scanner,
 * gym and branch; a token from another device cannot be redeemed. The
 * findOneAndUpdate is the replay barrier: only one caller can flip pending ->
 * consumed.
 */
async function redeemDoorAuthorization({ scanner, token, now = new Date() }) {
  if (!scanner || !scanner._id || !scanner.gymId || !token) {
    return { authorized: false, reason: "invalid_request" };
  }

  const authorization = await DoorAuthorization.findOneAndUpdate(
    {
      tokenHash: hashToken(token),
      scanner: scanner._id,
      gymId: scanner.gymId,
      branchCode: scanner.branchCode || "MAIN",
      status: "pending",
      expiresAt: { $gt: now }
    },
    {
      $set: {
        status: "consumed",
        consumedAt: now
      }
    },
    { new: true }
  );

  if (!authorization) {
    return { authorized: false, reason: "invalid_or_expired" };
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
