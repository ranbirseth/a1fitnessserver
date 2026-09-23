const mongoose = require("mongoose");

const workoutPlanSchema = new mongoose.Schema({
  gymId: { type: String, required: true, index: true },
  branchCode: { type: String, default: "MAIN", uppercase: true, trim: true, index: true },
  name: { type: String, required: true },
  goal: { 
    type: String, 
    enum: ["Fat Loss", "Muscle Gain", "Strength", "General Fitness"],
    required: true 
  },
  difficulty: { 
    type: String, 
    enum: ["Beginner", "Intermediate", "Advanced"],
    required: true 
  },
  isTemplate: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "Member" },
  sourceTemplate: { type: mongoose.Schema.Types.ObjectId, ref: "WorkoutPlan" }, // set on member copies created from a template
  days: [
    {
      dayName: { type: String, required: true }, // e.g., "Day 1: Chest + Triceps"
      exercises: [
        {
          name: { type: String, required: true },
          sets: { type: Number, required: true },
          reps: { type: String, required: true }, // Using String to allow "10-12" or "Until Failure"
          rest: { type: String, default: "60s" },
          instructions: String,
          videoUrl: String
        }
      ]
    }
  ]
}, { timestamps: true });

module.exports = mongoose.models.WorkoutPlan || mongoose.model("WorkoutPlan", workoutPlanSchema);
