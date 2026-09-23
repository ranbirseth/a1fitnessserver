require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("./models/user.model");

const ACCOUNTS = [
  { email: "sa@gmail.com", password: "sa1234", role: "superadmin", name: "Super Admin", gymId: "MAIN", branchCode: "MAIN" },
  { email: "a@gmail.com", password: "a12345", role: "admin", name: "Admin", gymId: "MAIN", branchCode: "MAIN" }
];

async function upsertAccount(account) {
  const { email, password, ...rest } = account;
  const existing = await User.findOne({ email: { $regex: new RegExp(`^${email}$`, "i") } });
  if (existing) {
    const payload = {
      ...rest,
      email,
      password: await bcrypt.hash(password, 10)
    };
    await User.collection.updateOne({ _id: existing._id }, { $set: payload });
    console.log(`UPDATED ${account.role}: ${email}`);
    return;
  }
  if (account.role === "admin") {
    const slotHolder = await User.findOne({ gymId: account.gymId, branchCode: account.branchCode, role: "admin" });
    if (slotHolder) {
      await User.deleteOne({ _id: slotHolder._id });
      console.log(`REMOVED old admin to free branch slot: ${slotHolder.email}`);
    }
  }
  const payload = {
    ...rest,
    email,
    password: await bcrypt.hash(password, 10)
  };
  await User.collection.insertOne({ ...payload, createdAt: new Date(), updatedAt: new Date() });
  console.log(`CREATED ${account.role}: ${email}`);
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  for (const account of ACCOUNTS) await upsertAccount(account);
  console.log("Done.");
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});