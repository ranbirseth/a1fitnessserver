const mongoose = require("mongoose");
const URI = "mongodb+srv://ranbirseth7679554766_db_user:Eg0Pt9E1WToLyjZp@a1-fitness.j92wdbq.mongodb.net/gymza_payflow_test?retryWrites=true&w=majority";

const scratchSchema = new mongoose.Schema(
  {
    gymId: { type: String, required: true },
    amount: { type: Number, required: true },
    termKey: { type: String },
    idempotencyKey: { type: String },
  },
  { timestamps: true }
);
scratchSchema.index({ gymId: 1, termKey: 1 }, { unique: true, sparse: true });
scratchSchema.index({ gymId: 1, idempotencyKey: 1 }, { unique: true, sparse: true });
const Scratch = mongoose.model("Scratch", scratchSchema);

(async () => {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 15000 });
  await Scratch.deleteMany({ gymId: "SCRATCH" });

  const mk = (over = {}) => ({ gymId: "SCRATCH", amount: 100, ...over });

  // 1) object-create WITHOUT termKey/idempotencyKey
  const d1 = await Scratch.create(mk());
  const r1 = await Scratch.collection.findOne({ _id: d1._id });
  console.log("[object create, no keys] termKey:", JSON.stringify(r1.termKey), "| hasOwn:", Object.prototype.hasOwnProperty.call(r1, "termKey"),
    "| idem:", JSON.stringify(r1.idempotencyKey), "| hasOwn:", Object.prototype.hasOwnProperty.call(r1, "idempotencyKey"));

  // 2) array-create WITHOUT termKey/idempotencyKey  -> expect 11000 if previous doc stored null
  try {
    const d2 = await Scratch.create([mk()]);
    const r2 = await Scratch.collection.findOne({ _id: d2[0]._id });
    console.log("[array create, no keys] termKey:", JSON.stringify(r2.termKey), "| hasOwn:", Object.prototype.hasOwnProperty.call(r2, "termKey"),
      "| idem:", JSON.stringify(r2.idempotencyKey), "| hasOwn:", Object.prototype.hasOwnProperty.call(r2, "idempotencyKey"));
  } catch (e) {
    console.log("[array create, no keys] ERROR:", e.code, "| keyPattern:", JSON.stringify(e.keyPattern), "| keyValue:", JSON.stringify(e.keyValue));
  }

  // 3) object-create with EXPLICIT null
  try {
    const d3 = await Scratch.create(mk({ termKey: null }));
    const r3 = await Scratch.collection.findOne({ _id: d3._id });
    console.log("[object create, termKey:null] termKey:", JSON.stringify(r3.termKey), "| hasOwn:", Object.prototype.hasOwnProperty.call(r3, "termKey"));
  } catch (e) {
    console.log("[object create, termKey:null] ERROR:", e.code, "| keyPattern:", JSON.stringify(e.keyPattern), "| keyValue:", JSON.stringify(e.keyValue));
  }

  // 4) object-create with termKey VALUE
  const d4 = await Scratch.create(mk({ termKey: "scratch:key1" }));
  console.log("[object create, termKey value] ok, id:", d4._id);

  // 5) second doc with DIFFERENT value (baseline sanity)
  const d5 = await Scratch.create(mk({ termKey: "scratch:key2" }));
  console.log("[object create, termKey value2] ok, id:", d5._id);

  await Scratch.deleteMany({ gymId: "SCRATCH" });
  await mongoose.disconnect();
})();