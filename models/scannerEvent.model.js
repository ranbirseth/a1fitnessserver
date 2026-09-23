const mongoose = require("mongoose");

const scannerEventSchema = new mongoose.Schema(
  {
    gymId: { type: String, required: true, index: true },
    branchCode: { type: String, default: "MAIN", index: true },
    scanner: { type: mongoose.Schema.Types.ObjectId, ref: "Scanner", index: true },
    deviceId: { type: String, index: true },
    member: { type: mongoose.Schema.Types.ObjectId, ref: "Member", default: null },
    attendance: { type: mongoose.Schema.Types.ObjectId, ref: "Attendance", default: null },
    eventType: { type: String, enum: ["fingerprint", "card", "pin", "face"], default: "fingerprint" },
    decision: { type: String, enum: ["allow", "deny"], required: true },
    reason: {
      type: String,
      enum: [
        "verified",
        "not_matched",
        "unknown_user",
        "ineligible",
        "expired",
        "payment_pending",
        "duplicate",
        "checkout",
        "branch_mismatch",
        "disabled_device"
      ],
      default: "verified",
    },
    deviceEventId: { type: String, sparse: true, unique: true },
    timestamp: { type: Date, required: true, index: true },
    raw: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

scannerEventSchema.index({ gymId: 1, timestamp: -1 });

module.exports = mongoose.model("ScannerEvent", scannerEventSchema);