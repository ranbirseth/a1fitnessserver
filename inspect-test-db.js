const mongoose = require("mongoose");
const URI = "mongodb+srv://ranbirseth7679554766_db_user:Eg0Pt9E1WToLyjZp@a1-fitness.j92wdbq.mongodb.net/gymza_payflow_test?retryWrites=true&w=majority";

(async () => {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.db;
  const users = await db.collection("users").find({}, { projection: { email: 1, gymId: 1, role: 1, branchCode: 1, status: 1 } }).toArray();
  console.log("USER COUNT:", users.length);
  users.forEach((u) => console.log(u.gymId, "|", u.role, "|", u.email, "|", u.branchCode, "|", u.status));

  const members = await db.collection("members").find({}, { projection: { gymId: 1, branchCode: 1, user: 1 } }).toArray();
  console.log("MEMBER COUNT:", members.length);
  members.forEach((m) => console.log(m.gymId, "|", m.branchCode, "|", m.user));

  const plans = await db.collection("plans").find({}, { projection: { gymId: 1, name: 1 } }).toArray();
  console.log("PLAN COUNT:", plans.length);
  plans.forEach((p) => console.log(p.gymId, "|", p.name));

  const pb = await db.collection("planbranches").find({}, { projection: { gymId: 1, planId: 1, branchCode: 1 } }).toArray();
  console.log("PLANBRANCH COUNT:", pb.length);
  pb.forEach((p) => console.log(p.gymId, "|", p.planId, "|", p.branchCode));

  const pay = await db.collection("payments").find({}, { projection: { gymId: 1, invoiceNumber: 1, amount: 1 } }).toArray();
  console.log("PAYMENT COUNT:", pay.length);
  pay.forEach((p) => console.log(p.gymId, "|", p.invoiceNumber, "|", p.amount));

  await mongoose.disconnect();
})();