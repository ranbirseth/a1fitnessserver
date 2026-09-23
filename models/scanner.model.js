const mongoose = require("mongoose");

const errorLogSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    level: { type: String, enum: ["info", "warn", "error"], default: "error" },
    message: String,
  },
  { _id: false }
);

const scannerSchema = new mongoose.Schema(
  {
    gymId: { type: String, required: true, index: true },
    branchCode: { type: String, default: "MAIN", index: true },
    name: { type: String, required: true, trim: true },
    brand: { type: String, default: "eSSL", trim: true },
    model: { type: String, default: "K30 Pro", trim: true },
    deviceId: { type: String, required: true, trim: true, unique: true, index: true },
    serial: { type: String, trim: true },
    ipAddress: { type: String, trim: true },
    port: { type: Number, default: 8200 },
    deviceTimezone: { type: String, trim: true, default: "Asia/Kolkata" },
    protocol: { type: String, enum: ["tcp", "usb", "p2p"], default: "tcp" },
    type: {
      type: String,
      enum: ["fingerprint", "card", "fingerprint_card", "face"],
      default: "fingerprint_card",
    },
    status: {
      type: String,
      enum: ["online", "offline", "maintenance", "disabled"],
      default: "offline",
      index: true,
    },
    apiKeyHash: { type: String, select: false },
    gates: [{ type: String, trim: true }],
    settings: {
      enforceMembership: { type: Boolean, default: true },
      enableCheckOutOnSecondScan: { type: Boolean, default: true },
    },
    lastSeen: { type: Date, default: null },
    lastEventAt: { type: Date, default: null },
    lastSync: { type: Date, default: null },
    errorLogs: [errorLogSchema],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

scannerSchema.index({ gymId: 1, branchCode: 1 });
scannerSchema.index({ serial: 1 }, { unique: true, sparse: true });

scannerSchema.methods.logError = function (message, level = "error") {
  this.errorLogs.push({ message, level, at: new Date() });
  if (this.errorLogs.length > 50) this.errorLogs = this.errorLogs.slice(-50);
  return this.save();
};

module.exports = mongoose.model("Scanner", scannerSchema);