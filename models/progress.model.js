const mongoose = require("mongoose");

const progressSchema = new mongoose.Schema(
  {
    gymId: { type: String, required: true, index: true },
    member: { type: mongoose.Schema.Types.ObjectId, ref: "Member", required: true, index: true },
    weightKg: { type: Number, required: true },
    heightCm: { type: Number, required: true },
    bmi: { type: Number, required: true },
    notes: String
  },
  { timestamps: true }
);

module.exports = mongoose.model("Progress", progressSchema);
