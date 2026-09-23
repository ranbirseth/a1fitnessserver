const mongoose = require("mongoose");

const dietPlanSchema = new mongoose.Schema({
  gymId: { type: String, required: true, index: true },
  branchCode: { type: String, default: "MAIN", uppercase: true, trim: true, index: true },
  name: { type: String, required: true },
  goal: { 
    type: String, 
    enum: ["Weight Loss", "Muscle Gain", "Maintenance"],
    required: true 
  },
  calories: Number,
  isTemplate: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "Member" },
  sourceTemplate: { type: mongoose.Schema.Types.ObjectId, ref: "DietPlan" }, // set on member copies created from a template
  meals: {
    breakfast: [
      {
        foodName: { type: String, required: true },
        quantity: { type: String, required: true }, // e.g., "100g" or "2 units"
        calories: Number,
        protein: Number,
        carbs: Number,
        fat: Number
      }
    ],
    lunch: [
      {
        foodName: { type: String, required: true },
        quantity: { type: String, required: true },
        calories: Number,
        protein: Number,
        carbs: Number,
        fat: Number
      }
    ],
    dinner: [
      {
        foodName: { type: String, required: true },
        quantity: { type: String, required: true },
        calories: Number,
        protein: Number,
        carbs: Number,
        fat: Number
      }
    ],
    snacks: [
      {
        foodName: { type: String, required: true },
        quantity: { type: String, required: true },
        calories: Number,
        protein: Number,
        carbs: Number,
        fat: Number
      }
    ]
  }
}, { timestamps: true });

module.exports = mongoose.models.DietPlan || mongoose.model("DietPlan", dietPlanSchema);
