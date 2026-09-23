const mongoose = require("mongoose");

const planBranchSchema = new mongoose.Schema(
  {
    gymId: { type: String, required: true, index: true },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: "Plan", required: true, index: true },
    branchCode: { type: String, required: true, trim: true, uppercase: true },
    status: { type: String, enum: ["active", "inactive"], default: "active", index: true }
  },
  { timestamps: true }
);

planBranchSchema.index({ gymId: 1, planId: 1, branchCode: 1 }, { unique: true });

module.exports = mongoose.model("PlanBranch", planBranchSchema);
