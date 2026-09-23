const mongoose = require("mongoose");

const auditLogSchema = new mongoose.Schema(
  {
    gymId: { type: String, required: true, index: true },
    targetId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    targetType: { type: String, required: true, enum: ["Member", "User", "Plan", "Trainer"] },
    action: { type: String, required: true, index: true },
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    oldValues: mongoose.Schema.Types.Mixed,
    newValues: mongoose.Schema.Types.Mixed,
    reason: String,
    metadata: mongoose.Schema.Types.Mixed
  },
  { timestamps: true }
);

module.exports = mongoose.model("AuditLog", auditLogSchema);
