const mongoose = require("mongoose");

const planSchema = new mongoose.Schema(
  {
    gymId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },
    duration: { type: Number, required: true, min: 1 }, // Duration in days
    features: [{ type: String }],
    branchCode: { type: String, default: null, trim: true, uppercase: true, index: true } // null or "ALL" for all branches
  },
  { timestamps: true }
);

planSchema.index({ gymId: 1, name: 1, branchCode: 1 }, { unique: true });

module.exports = mongoose.model("Plan", planSchema);
