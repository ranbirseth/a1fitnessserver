require("dotenv").config();
const { connectDb } = require("../config/db");
const { seedData, ensureDevSuperadmin, ensureDevTrainer, ensureDevMember } = require("./seedLogic");
const mongoose = require("mongoose");

const run = async () => {
  try {
    await connectDb();
    await seedData();
    await ensureDevSuperadmin();
    await ensureDevTrainer();
    await ensureDevMember();
    console.log("Manual seed script finished successfully.");
    process.exit(0);
  } catch (err) {
    console.error("Seed script failed:", err);
    process.exit(1);
  }
};

run();
