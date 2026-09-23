const mongoose = require("mongoose");

const memberSchema = new mongoose.Schema(
  {
    gymId: { type: String, required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    trainer: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    currentPlan: { type: mongoose.Schema.Types.ObjectId, ref: "Plan", index: true },
    membershipStartDate: Date,
    membershipExpiryDate: { type: Date, index: true },
    isActivePlan: { type: Boolean, default: false, index: true },
    status: { type: String, enum: ["pending", "active", "expired", "cancelled", "inactive", "frozen"], default: "pending", index: true },
    paymentStatus: { type: String, enum: ["paid", "pending"], default: "pending", index: true },
    secretCode: { type: String, unique: true, sparse: true }, // 3-digit unique code
    assignedWorkout: { type: mongoose.Schema.Types.ObjectId, ref: "WorkoutPlan" },
    assignedDiet: { type: mongoose.Schema.Types.ObjectId, ref: "DietPlan" },
    frozenAt: Date,
    remainingDays: Number,
    branchCode: { type: String, default: "MAIN", index: true },
    biometrics: {
      deviceUserId: { type: String, trim: true, index: true, sparse: true },
      cardId: { type: String, trim: true, index: true, sparse: true },
      fingerprints: { type: [String], default: [] }
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model("Member", memberSchema);
