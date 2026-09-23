const User = require("../models/user.model");
const Member = require("../models/member.model");

const DEFAULT_ADMIN = {
  gymId: "MAIN",
  name: " gym Admin",
  email: "admin@gmail.com",
  password: "admin2026",
  role: "admin",
  phone: "78656647534",
  status: "active"
};

const DEV_SUPERADMIN = {
  gymId: "MAIN",
  name: "Dev Superadmin",
  email: "superadmin@dev.local",
  password: "superadmin2026",
  role: "superadmin",
  branchCode: "MAIN",
  status: "active"
};

const DEV_TRAINER = {
  gymId: "MAIN",
  name: "Dev Trainer",
  email: "trainer@dev.local",
  password: "trainer2026",
  role: "trainer",
  branchCode: "MAIN",
  status: "active"
};

const DEV_MEMBER = {
  gymId: "MAIN",
  name: "Dev Member",
  email: "member@dev.local",
  password: "member2026",
  role: "member",
  branchCode: "MAIN",
  status: "active"
};

const seedData = async () => {
  // Never inject a demo Default Admin once the database has been initialized
  // (a Super Admin already exists). This keeps a reset database truly empty.
  if (await User.exists({ role: "superadmin" })) {
    console.log("Super Admin exists. Skipping Default Admin demo seeding.");
    return;
  }

  const adminExists = await User.exists({ role: "admin" });

  if (adminExists) {
    console.log("Default Admin already exists.");
    return;
  }

  console.log("Database empty. Creating default data...");

  await User.create(DEFAULT_ADMIN);

  console.log("===================================");
  console.log("Default Admin Created");
  console.log("Email:");
  console.log(DEFAULT_ADMIN.email);
  console.log("\nPassword:");
  console.log(DEFAULT_ADMIN.password);
  console.log("\nGym:");
  console.log(DEFAULT_ADMIN.gymId);
  console.log("===================================");
};

/**
 * DEVELOPMENT-ONLY: Creates accounts for testing all four roles.
 * All functions are gated by NODE_ENV — they NEVER run in production.
 */
const ensureDevSuperadmin = async () => {
  if (process.env.NODE_ENV === "production" || process.env.RENDER) return;
  if (await User.exists({ role: "superadmin" })) return;
  try {
    await User.create(DEV_SUPERADMIN);
    console.log("[DEV] Superadmin created:", DEV_SUPERADMIN.email);
  } catch (err) {
    console.error("[DEV] Failed to create superadmin:", err.message);
  }
};

const ensureDevTrainer = async () => {
  if (process.env.NODE_ENV === "production" || process.env.RENDER) return;
  // Skip demo seeding once the DB is initialized (Super Admin exists).
  if (await User.exists({ role: "superadmin" })) {
    console.log("Super Admin exists. Skipping dev Trainer demo seeding.");
    return;
  }
  if (await User.exists({ role: "trainer" })) return;
  try {
    await User.create(DEV_TRAINER);
    console.log("[DEV] Trainer created:", DEV_TRAINER.email);
  } catch (err) {
    console.error("[DEV] Failed to create trainer:", err.message);
  }
};

const ensureDevMember = async () => {
  if (process.env.NODE_ENV === "production" || process.env.RENDER) return;
  // Skip demo seeding once the DB is initialized (Super Admin exists).
  if (await User.exists({ role: "superadmin" })) {
    console.log("Super Admin exists. Skipping dev Member demo seeding.");
    return;
  }
  if (await User.exists({ email: DEV_MEMBER.email, gymId: DEV_MEMBER.gymId })) return;
  try {
    const user = await User.create(DEV_MEMBER);
    const secretCode = Math.floor(100 + Math.random() * 900).toString();
    await Member.create({
      gymId: DEV_MEMBER.gymId,
      user: user._id,
      branchCode: "MAIN",
      isActivePlan: true,
      status: "active",
      paymentStatus: "paid",
      secretCode
    });
    console.log("[DEV] Member created:", DEV_MEMBER.email);
  } catch (err) {
    console.error("[DEV] Failed to create member:", err.message);
  }
};

module.exports = { seedData, ensureDevSuperadmin, ensureDevTrainer, ensureDevMember };
