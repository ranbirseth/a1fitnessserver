const mongoose = require("mongoose");
const URI = "mongodb+srv://ranbirseth7679554766_db_user:Eg0Pt9E1WToLyjZp@a1-fitness.j92wdbq.mongodb.net/gymza_payflow_test?retryWrites=true&w=majority";

(async () => {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.db;
  const idx = await db.collection("payments").listIndexes().toArray();
  console.log("=== INDEXES on payments ===");
  idx.forEach((i) => {
    console.log("name:", i.name, "| keys:", JSON.stringify(i.key), "| unique:", !!i.unique, "| sparse:", !!i.sparse);
  });

  console.log("");
  const docs = await db.collection("payments").find({}).toArray();
  console.log("total docs:", docs.length);
  docs.forEach((d) => console.log("doc:", d._id, "| termKey:", JSON.stringify(d.termKey), "| idempotencyKey:", JSON.stringify(d.idempotencyKey)));
  await mongoose.disconnect();
})();