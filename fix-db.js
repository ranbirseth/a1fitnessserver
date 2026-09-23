require("dotenv").config();
const mongoose = require("mongoose");
const WorkoutPlan = require("./models/workout.model");
const DietPlan = require("./models/diet.model");

const fix = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to DB");

    // Update all WorkoutPlans to have isTemplate: true if they don't have it
    const resW = await WorkoutPlan.updateMany(
      { isTemplate: { $exists: false } },
      { $set: { isTemplate: true } }
    );
    console.log(`Updated ${resW.modifiedCount} WorkoutPlans`);

    // Update all DietPlans to have isTemplate: true if they don't have it
    const resD = await DietPlan.updateMany(
      { isTemplate: { $exists: false } },
      { $set: { isTemplate: true } }
    );
    console.log(`Updated ${resD.modifiedCount} DietPlans`);

    await mongoose.disconnect();
    console.log("Disconnected from DB");
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

fix();
