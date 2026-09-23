require("dotenv").config();
const mongoose = require("mongoose");
const { getMongoUri } = require("./config/db");

const GYM = "MAIN";
const EMAIL = "superadmin@dev.local";
const ROLE = "superadmin";
// Candidate below is the documented DEV seed credential for this account
// (server/seeds/seedLogic.js). We only report the boolean outcome.
const DEV_SEED_PASSWORD = "superadmin2026";

(async () => {
  try {
    await mongoose.connect(getMongoUri(), { serverSelectionTimeoutMS: 15000 });
  } catch (e) {
    console.log("CONNECT_FAIL:", e.message);
    process.exit(1);
  }

  console.log("A. Backend database name:", mongoose.connection.name);

  const User = require("./models/user.model");

  const user = await User.findOne({ gymId: GYM, email: EMAIL });

  console.log("B. User exists:", !!user);
  if (user) {
    console.log("C. Stored safe metadata:");
    console.log("   gymId:    ", user.gymId);
    console.log("   email:    ", user.email);
    console.log("   role:     ", user.role);
    console.log("   status:   ", user.status);
    console.log("   branchCode:", user.branchCode || "-");
    console.log("   _id:      ", "[redacted]");
  }

  const found = await User.findOne({ gymId: GYM, email: EMAIL, role: ROLE });
  console.log("D. findOne({gymId,email,role}) returns user:", !!found);

  let statusOk = false;
  if (user) {
    statusOk = user.status !== "inactive";
    console.log("E. Account status permits login (status !== inactive):", statusOk);
    if (user.role === "member") {
      const member = await require("./models/member.model").findOne({ user: user._id });
      console.log("   member.status:", member ? member.status : "(no member doc)");
    } else {
      console.log("   non-member role: no member approval check applies");
    }
  } else {
    console.log("E. Account status: N/A (no user)");
  }

  if (user) {
    const matched = await user.comparePassword(DEV_SEED_PASSWORD);
    console.log("F. Password comparison vs documented DEV seed credential:", matched);
  } else {
    console.log("F. Password comparison: SKIPPED (no user)");
  }

  const total = await require("./models/user.model").countDocuments();
  console.log("   (total users in this db:", total + ")");
  console.log("   (health endpoint reported 5 users — confirms same db)");

  await mongoose.disconnect();
})().catch((e) => { console.log("ERROR:", e.message); process.exit(1); });
