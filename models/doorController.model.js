const mongoose = require("mongoose");

const doorControllerSchema = new mongoose.Schema(
  {
    gymId: { type: String, required: true, index: true },
    branchCode: { type: String, default: "MAIN", index: true },
    name: { type: String, trim: true },
    controllerId: { type: String, required: true, trim: true, unique: true, index: true },
    apiKeyHash: { type: String, select: false },
    controllerKeyHash: { type: String, select: false },
    status: {
      type: String,
      enum: ["online", "offline", "maintenance", "disabled"],
      default: "offline",
      index: true
    },
    allowedScannerIds: [{ type: String, trim: true }],
    allowedScanners: [{ type: mongoose.Schema.Types.ObjectId, ref: "Scanner" }],
    lastSeen: { type: Date, default: null }
  },
  { timestamps: true }
);

doorControllerSchema.index({ gymId: 1, branchCode: 1 });

module.exports = mongoose.model("DoorController", doorControllerSchema);
