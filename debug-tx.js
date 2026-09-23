const mongoose = require("mongoose");
const Member = require("./models/member.model");
const Plan = require("./models/plan.model");
const Payment = require("./models/payment.model");
const Notification = require("./models/notification.model");

const URI = "mongodb+srv://ranbirseth7679554766_db_user:Eg0Pt9E1WToLyjZp@a1-fitness.j92wdbq.mongodb.net/gymza_payflow_test?retryWrites=true&w=majority";

(async () => {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 15000 });
  const member = await Member.findOne({ gymId: "TEST", branchCode: "BR_A" }).sort({ createdAt: 1 });
  const plan = await Plan.findOne({ gymId: "TEST", name: "Basic Plan" });

  // Check for any existing payment with termKey (should be none)
  const existing = await Payment.find({ gymId: "TEST", termKey: { $exists: true } });
  console.log("Payments WITH termKey:", existing.length);

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const startDate = new Date();
    const expiryDate = new Date(startDate); expiryDate.setDate(expiryDate.getDate() + plan.duration);
    const termKey = member._id + ":" + plan._id + ":" + startDate.toISOString();
    console.log("termKey:", termKey);

    member.currentPlan = plan._id;
    member.membershipStartDate = startDate;
    member.membershipExpiryDate = expiryDate;
    member.status = "active";
    member.paymentStatus = "paid";
    member.isActivePlan = true;
    await member.save({ session });
    console.log("member.save OK");

    const paymentData = {
      gymId: "TEST",
      member: member._id,
      plan: plan._id,
      amount: plan.price,
      method: "cash",
      status: "paid",
      note: "debug",
      date: new Date(),
      invoiceNumber: "INV-DEBUG-" + Date.now(),
      branchCode: "BR_A",
      membershipStartDate: startDate,
      membershipExpiryDate: expiryDate,
      operationType: "assign",
      termKey,
      invoice: { createdAt: new Date().toISOString() }
    };
    const [payment] = await Payment.create([paymentData], { session });
    console.log("Payment.create OK, id:", payment._id);

    await Notification.create([{ user: member.user, title: "T", message: "M", type: "payment" }], { session });
    console.log("Notification.create OK");

    await session.commitTransaction();
    console.log("COMMIT OK");
  } catch (e) {
    console.log("ERROR:", e.message);
    console.log("ERROR code:", e.code, "| codeName:", e.codeName);
    console.log("ERROR keyPattern:", JSON.stringify(e.keyPattern));
    console.log("ERROR keyValue:", JSON.stringify(e.keyValue));
    try { await session.abortTransaction(); } catch {}
  } finally {
    session.endSession();
    await mongoose.disconnect();
  }
})();