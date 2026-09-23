// Seeds isolated gymza_payflow_test DB with TEST-gym data for the payflow suite.
const mongoose = require("mongoose");
const User = require("./models/user.model");
const Member = require("./models/member.model");
const Plan = require("./models/plan.model");
const PlanBranch = require("./models/planBranch.model");
const Payment = require("./models/payment.model");

const URI = "mongodb+srv://ranbirseth7679554766_db_user:Eg0Pt9E1WToLyjZp@a1-fitness.j92wdbq.mongodb.net/gymza_payflow_test?retryWrites=true&w=majority";

(async () => {
  try {
    await mongoose.connect(URI, { serverSelectionTimeoutMS: 15000 });
    console.log("Connected to gymza_payflow_test");

    const db = mongoose.connection.db;

    // Clean only TEST-gym data so re-runs are idempotent
    await Promise.all([
      db.collection("users").deleteMany({ gymId: "TEST" }),
      db.collection("members").deleteMany({ gymId: "TEST" }),
      db.collection("plans").deleteMany({ gymId: "TEST" }),
      db.collection("planbranches").deleteMany({ gymId: "TEST" }),
      db.collection("payments").deleteMany({ gymId: "TEST" }),
      db.collection("notifications").deleteMany({}),
    ]);
    console.log("Cleared previous TEST-gym data");

    const superadmin = await User.create({
      gymId: "TEST",
      name: "Test Superadmin",
      email: "sa@payflow.local",
      password: "Super123456",
      role: "superadmin",
      branchCode: "MAIN",
      status: "active",
    });

    const adminA = await User.create({
      gymId: "TEST",
      name: "Admin A",
      email: "admin_a@payflow.local",
      password: "Admin123456",
      role: "admin",
      branchCode: "BR_A",
      status: "active",
    });

    const adminB = await User.create({
      gymId: "TEST",
      name: "Admin B",
      email: "admin_b@payflow.local",
      password: "Admin123456",
      role: "admin",
      branchCode: "BR_B",
      status: "active",
    });

    const userA = await User.create({
      gymId: "TEST",
      name: "Member A",
      email: "member_a@payflow.local",
      password: "Member123456",
      role: "member",
      branchCode: "BR_A",
      status: "active",
    });

    const userB = await User.create({
      gymId: "TEST",
      name: "Member B",
      email: "member_b@payflow.local",
      password: "Member123456",
      role: "member",
      branchCode: "BR_B",
      status: "active",
    });

    const memberA = await Member.create({
      gymId: "TEST",
      user: userA._id,
      currentPlan: null,
      status: "active",
      paymentStatus: "pending",
      isActivePlan: false,
      secretCode: String(100 + Math.floor(Math.random() * 900)),
      branchCode: "BR_A",
    });

    const memberB = await Member.create({
      gymId: "TEST",
      user: userB._id,
      currentPlan: null,
      status: "active",
      paymentStatus: "pending",
      isActivePlan: false,
      secretCode: String(100 + Math.floor(Math.random() * 900)),
      branchCode: "BR_B",
    });

    const planA = await Plan.create({
      gymId: "TEST",
      name: "Basic Plan",
      duration: 30,
      price: 1000,
      status: "active",
    });

    const planB = await Plan.create({
      gymId: "TEST",
      name: "Premium Plan",
      duration: 60,
      price: 2500,
      status: "active",
    });

    // PlanBranch: Plan A only in BR_A; Plan B in BR_A and BR_B
    await PlanBranch.create({ gymId: "TEST", planId: planA._id, branchCode: "BR_A", status: "active" });
    await PlanBranch.create({ gymId: "TEST", planId: planB._id, branchCode: "BR_A", status: "active" });
    await PlanBranch.create({ gymId: "TEST", planId: planB._id, branchCode: "BR_B", status: "active" });

    const legacyPayment = await Payment.create({
      gymId: "TEST",
      member: memberA._id,
      plan: planA._id,
      amount: 1000,
      date: new Date("2025-12-01T10:00:00Z"),
      method: "cash",
      status: "paid",
      note: "Legacy payment (no termKey)",
      invoiceNumber: "INV-LEGACY-001",
      branchCode: "BR_A",
    });

    console.log("Seed complete:");
    console.log("  superadmin:", superadmin._id, "sa@payflow.local / Super123456");
    console.log("  adminA:", adminA._id, "BR_A");
    console.log("  adminB:", adminB._id, "BR_B");
    console.log("  memberA:", memberA._id, "BR_A");
    console.log("  memberB:", memberB._id, "BR_B");
    console.log("  planA:", planA._id, "Basic 30d ₹1000 (BR_A only)");
    console.log("  planB:", planB._id, "Premium 60d ₹2500 (BR_A + BR_B)");
    console.log("  legacyPayment:", legacyPayment._id, "(no termKey/idempotencyKey)");

    await mongoose.disconnect();
  } catch (e) {
    console.error("SEED ERR:", e);
    process.exit(1);
  }
})();