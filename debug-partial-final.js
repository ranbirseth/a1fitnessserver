const mongoose = require("mongoose");
const URI = "mongodb+srv://ranbirseth7679554766_db_user:Eg0Pt9E1WToLyjZp@a1-fitness.j92wdbq.mongodb.net/gymza_payflow_test?retryWrites=true&w=majority";

const s = new mongoose.Schema(
  { gymId: { type: String, required: true }, termKey: { type: String }, idempotencyKey: { type: String } },
  { minimize: false }
);
s.index({ gymId: 1, termKey: 1 }, { unique: true, partialFilterExpression: { termKey: { $type: "string" } } });
s.index({ gymId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } });
const P = mongoose.model("PFinal", s);

(async () => {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 15000 });
  const c = P.collection;
  await c.deleteMany({ gymId: "C" });
  try { await c.dropIndex("gymId_1_termKey_1"); } catch {}
  try { await c.dropIndex("gymId_1_idempotencyKey_1"); } catch {}
  const idx = await c.listIndexes().toArray();
  console.log(JSON.stringify(idx.filter((i) => /termKey|idempotency/.test(i.name)).map((i) => ({ name: i.name, unique: i.unique, partialFilterExpression: i.partialFilterExpression })), null, 2));
  await c.deleteMany({ gymId: "C" });
  await mongoose.disconnect();
})();