const mongoose = require("mongoose");
const URI = "mongodb+srv://ranbirseth7679554766_db_user:Eg0Pt9E1WToLyjZp@a1-fitness.j92wdbq.mongodb.net/gymza_payflow_test?retryWrites=true&w=majority";

const mkSchema = new mongoose.Schema(
  {
    gymId: { type: String, required: true },
    amount: { type: Number, required: true },
    termKey: { type: String },
    idempotencyKey: { type: String },
  },
  { timestamps: true }
);
mkSchema.index({ gymId: 1, termKey: 1 }, { unique: true, partialFilterExpression: { termKey: { $type: "string" } } });
mkSchema.index({ gymId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } });
const Mk = mongoose.model("MkPartial", mkSchema);

(async () => {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 15000 });
  const coll = Mk.collection;
  const base = () => ({ gymId: "B", amount: 100 });

  await coll.deleteMany({ gymId: "B" });
  // explicitly drop any old sparse indexes with the same auto-names
  try { await coll.dropIndex("gymId_1_termKey_1"); } catch {}
  try { await coll.dropIndex("gymId_1_idempotencyKey_1"); } catch {}

  console.log("--- PARTIAL index: many docs missing termKey ---");
  await Mk.create([base(), base(), base()]);
  console.log("3 docs, no termKey -> OK (partial excludes them)");

  console.log("--- expiryDate present, termKey present duplicated ---");
  try {
    await Mk.create([{ ...base(), termKey: "B:1" }, { ...base(), termKey: "B:1" }]);
    console.log("dup termKey -> UNEXPECTED OK");
  } catch (e) { console.log("dup termKey -> ERROR", e.code, JSON.stringify(e.keyValue)); }

  console.log("--- unique termKeys with one null idempotencyKey (simulate second real payment, idempotencyKey absent) ---");
  try {
    const d1 = await Mk.create([{ ...base(), termKey: "B:2", idempotencyKey: "K-1" }]);
    const d2 = await Mk.create([{ ...base(), termKey: "B:3" }]);
    console.log("ok ids:", d1[0]._id.toHexString().slice(0,8), d2[0]._id.toHexString().slice(0,8));
  } catch (e) { console.log("ERROR:", e.code, JSON.stringify(e.keyPattern), JSON.stringify(e.keyValue)); }

  await coll.deleteMany({ gymId: "B" });
  await mongoose.disconnect();
})();