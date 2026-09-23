const mongoose = require("mongoose");

const dietTemplateBranchSchema = new mongoose.Schema(
  {
    gymId: { type: String, required: true, index: true },
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: "DietPlan", required: true, index: true },
    branchCode: { type: String, required: true, trim: true, uppercase: true },
    status: { type: String, enum: ["active", "inactive"], default: "active", index: true }
  },
  { timestamps: true }
);

// A single reusable template can be applied to each branch at most once.
dietTemplateBranchSchema.index({ gymId: 1, templateId: 1, branchCode: 1 }, { unique: true });

module.exports = mongoose.model("DietTemplateBranch", dietTemplateBranchSchema);