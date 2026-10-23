const mongoose = require("mongoose");

const DOOR_AUTHORIZATION_STATUSES = ["pending", "consumed"];

const doorAuthorizationSchema = new mongoose.Schema(
  {
    gymId: { type: String, required: true, index: true },
    branchCode: { type: String, required: true, index: true },
    scanner: { type: mongoose.Schema.Types.ObjectId, ref: "Scanner", required: true, index: true },
    deviceId: { type: String, required: true, index: true },
    member: { type: mongoose.Schema.Types.ObjectId, ref: "Member", required: true, index: true },
    attendance: { type: mongoose.Schema.Types.ObjectId, ref: "Attendance", required: true, index: true },
    scannerEvent: { type: mongoose.Schema.Types.ObjectId, ref: "ScannerEvent", required: true, index: true },
    tokenHash: { type: String, required: true, unique: true, select: false },
    status: {
      type: String,
      enum: DOOR_AUTHORIZATION_STATUSES,
      default: "pending",
      index: true
    },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

doorAuthorizationSchema.index({ gymId: 1, branchCode: 1, scanner: 1, status: 1, expiresAt: 1 });
// Keep a short audit trail after expiry, but never retain authorizations forever.
doorAuthorizationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

module.exports = mongoose.model("DoorAuthorization", doorAuthorizationSchema);
module.exports.DOOR_AUTHORIZATION_STATUSES = DOOR_AUTHORIZATION_STATUSES;
