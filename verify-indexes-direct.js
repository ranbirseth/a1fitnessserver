const mongoose = require("mongoose");
const Payment = require("./models/payment.model");
const URI = "mongodb+srv://ranbirseth7679554766_db_user:Eg0Pt9E1WToLyjZp@a1-fitness.j92wdbq.mongodb.net/gymza_payflow_test?retryWrites=true&w=majority";

const G = "IDXCHK";
const base = (over = {}) => ({
  gymId: G,
  member: new mongoose.Types.ObjectId(),
  plan: new mongoose.Types.ObjectId(),
  amount: 500,
  method: "cash",
  status: "paid",
  invoiceNumber: "INV-IDX-" + Math.random().toString(36).slice(2, 10),
  branchCode: "MAIN",
  ...over
});

(async () => {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 15000 });
  const coll = Payment.collection;
  await coll.deleteMany({ gymId: G });
  const out = [];
  const check = async (label, fn) => {
    try { await fn(); out.push("PASS | " + label); }
    catch (e) { out.push("FAIL | " + label + " -> " + (e.code || "") + " " + (e.message || e)); }
  };

  await check("multiple docs WITHOUT termKey insert OK", async () => {
    await Payment.create([base({ operationType: "assign" }), base({ operationType: "assign" }), base({ operationType: "assign" })]);
    const n = await Payment.countDocuments({ gymId: G, termKey: { $exists: false } });
    if (n < 2) throw new Error("expected >=2 docs missing termKey, got " + n);
  });

  await check("multiple docs WITHOUT idempotencyKey insert OK", async () => {
    const n = await Payment.countDocuments({ gymId: G, idempotencyKey: { $exists: false } });
    if (n < 2) throw new Error("expected >=2 docs missing idempotencyKey, got " + n);
  });

  await check("duplicate real string termKey REJECTED (11000)", async () => {
    const t = "term:" + Date.now();
    await Payment.create(base({ termKey: t }));
    await Payment.create(base({ termKey: t }));
  });

  await check("duplicate real string idempotencyKey REJECTED (11000)", async () => {
    const k = "idem:" + Date.now();
    await Payment.create(base({ idempotencyKey: k }));
    await Payment.create(base({ idempotencyKey: k }));
  });

  await check("different real string termKey + idempotencyKey coexist OK", async () => {
    await Payment.create(base({ termKey: "t1:" + Date.now(), idempotencyKey: "k1:" + Date.now() }));
    await Payment.create(base({ termKey: "t2:" + Date.now(), idempotencyKey: "k2:" + Date.now() }));
  });

  await check("termKey string vs idempotencyKey string same value OK (separate columns)", async () => {
    const v = "shared:" + Date.now();
    await Payment.create(base({ termKey: v, idempotencyKey: v + "-other" }));
  });

  const idx = await coll.listIndexes().toArray();
  const relevant = idx.filter((i) => /termKey|idempotency/.test(i.name)).map((i) => ({
    name: i.name, unique: !!i.unique, partialFilterExpression: i.partialFilterExpression
  }));

  await coll.deleteMany({ gymId: G });
  console.log(out.join("\n"));
  console.log("\n=== relevant index defs ===");
  console.log(JSON.stringify(relevant, null, 2));
  await mongoose.disconnect();
})();