require("dotenv").config();

const mongoose = require("mongoose");
const User = require("./models/user.model");

async function createAdmin() {
  try {
    await mongoose.connect(process.env.MONGO_URI);

    const exists = await User.findOne({
      email: "A1Fitness@gmail.com",
    });

    if (exists) {
      console.log("Admin already exists.");
      process.exit();
    }

    await User.create({
      gymId: "MAIN",
      name: "A1Fitness",
      email: "A1Fitness@gmail.com",
      password: "A1fitness1234", // Your model should hash this automatically
      phone: "7455768798",
      role: "admin",
      status: "active",
    });

    console.log("✅ Admin created successfully.");
    process.exit();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

createAdmin();