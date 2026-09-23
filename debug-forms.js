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
mkSchema.index({ gymId: 1, termKey: 1 }, { unique: true, sparse: true });
mkSchema.index({ gymId: 1, idempotencyKey: 1 }, { unique: true, sparse: true });
const Mk = mongoose.model("Mk", mkSchema);

let clean = async () => Mk.deleteMany({ gymId: "A" });
let show = async (label, doc) => {
  const raw = await Mk.collection.findOne({ _id: doc._id });
  console.log(label, "| stored termKey hasOwn:", Object.prototype.hasOwnProperty.call(raw, "termKey"), JSON.stringify(raw.termKey), "| idem hasOwn:", Object.prototype.hasOwnProperty.call(raw, "idempotencyKey"), JSON.stringify(raw.idempotencyKey));
};

(async () => {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 15000 });
  const base = () => ({ gymId: "A", amount: 100 });

  await clean();
  console.log("--- OBJECT form (insertOne path) ---");
  const o1 = await Mk.create(base());
  await show("o1", o1);
  try { const o2 = await Mk.create(base()); await show("o2", o2); console.log("o2 ok"); }
  catch (e) { console.log("o2 ERROR:", e.code, "| keyValue:", JSON.stringify(e.keyValue)); }

  await clean();
  console.log("--- ARRAY form vs OBJECT form collision (controller uses ARRAY) ---");
  const ao1 = await Mk.create([base()]);
  const raw1 = await Mk.collection.findOne({ _id: ao1[0]._id });
  console.log("a1 stored | termKey hasOwn:", Object.prototype.hasOwnProperty.call(raw1, "termKey"), "->", JSON.stringify(raw1.termKey), "| idem hasOwn:", Object.prototype.hasOwnProperty.call(raw1, "idempotencyKey"), "->", JSON.stringify(raw1.idempotencyKey));
  try { const ao2 = await Mk.create([base()]); console.log("a2 ok:", ao2[0]._id); }
  catch (e) { console.log("a2 ERROR:", e.code, "| keyPattern:", JSON.stringify(e.keyPattern), "| keyValue:", JSON.stringify(e.keyValue)); }

  await clean();
  console.log("--- legacy style OBJECT absent then ARRAY absent (simulates legacy + new) ---");
  const lo = await Mk.create(base());
  await show("legacy", lo);
  try { const a2 = await Mk.create([base()]); console.log("new ok:", a2[0]._id); }
  catch (e) { console.log("new ERROR:", e.code, "| keyPattern:", JSON.stringify(e.keyPattern), "| keyValue:", JSON.stringify(e.keyValue)); }

  await Mk.deleteMany({ gymId: "A" });
  await mongoose.disconnect();
})();