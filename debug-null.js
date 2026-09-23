const mongoose = require("mongoose");
const Payment = require("./models/payment.model");
const Member = require("./models/member.model");
const Plan = require("./models/plan.model");

const URI = "mongodb+srv://ranbirseth7679554766_db_user:Eg0Pt9E1WToLyjZp@a1-fitness.j92wdbq.mongodb.net/gymza_payflow_test?retryWrites=true&w=majority";

(async () => {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 15000 });
  const member = await Member.findOne({ gymId: "TEST", branchCode: "BR_A" }).sort({ createdAt: 1 });
  const plan = await Plan.findOne({ gymId: "TEST", name: "Basic Plan" });

  const mk = () => ({
    gymId: "TEST",
    member: member._id,
    plan: plan._id,
    amount: 100,
    method: "cash",
    status: "paid",
    note: "probe",
    date: new Date(),
    invoiceNumber: "INV-PROBE-" + Date.now(),
    branchCode: "BR_A",
  });

  const p1 = await Payment.create(mk());
  const p1raw = await Payment.collection.findOne({ _id: p1._id });
  console.log("OBJECT create -> has idempotencyKey field:", Object.prototype.hasOwnProperty.call(p1raw, "idempotencyKey"), "| val:", JSON.stringify(p1raw.idempotencyKey), "| has termKey:", Object.prototype.hasOwnProperty.call(p1raw, "termKey"));

  const p2 = await Payment.create([mk()]);
  const p2raw = await Payment.collection.findOne({ _id: p2[0]._id });
  console.log("ARRAY create  -> has idempotencyKey field:", Object.prototype.hasOwnProperty.call(p2raw, "idempotencyKey"), "| val:", JSON.stringify(p2raw.idempotencyKey), "| has termKey:", Object.prototype.hasOwnProperty.call(p2raw, "termKey"));

  // cleanup probes
  await Payment.deleteMany({ note: "probe" });
  await mongoose.disconnect();
})();