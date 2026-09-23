// require("dotenv").config();

// const mongoose = require("mongoose");
// const User = require("./models/user.model");

// async function resetAdmin() {
//   try {
//     await mongoose.connect(process.env.MONGO_URI);

//     console.log("MongoDB connected");

//     // Remove all existing admin accounts
//     const deleted = await User.deleteMany({
//       role: "admin"
//     });

//     console.log(`Deleted ${deleted.deletedCount} old admin(s).`);

//     // Create the final admin
//     const admin = await User.create({
//       gymId: "MAIN",
//       name: "Gym Admin",
//       email: "admin@gmail.com",
//       password: "admin2026",
//       role: "admin",
//       phone: "78656647534",
//       status: "active"
//     });

//     console.log("\n================================");
//     console.log("FINAL ADMIN CREATED");
//     console.log("================================");
//     console.log("Gym ID:", admin.gymId);
//     console.log("Email:", admin.email);
//     console.log("Password: admin2026");
//     console.log("Role:", admin.role);
//     console.log("Status:", admin.status);
//     console.log("================================\n");

//     await mongoose.disconnect();
//   } catch (error) {
//     console.error("ERROR:", error);
//     process.exit(1);
//   }
// }

// resetAdmin();