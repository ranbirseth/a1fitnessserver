const mongoose = require("mongoose");
const URI = "mongodb+srv://ranbirseth7679554766_db_user:Eg0Pt9E1WToLyjZp@a1-fitness.j92wdbq.mongodb.net/gymza_payflow_test?retryWrites=true&w=majority";

(async () => {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.db;
  const docs = await db.collection("payments").find({}).toArray();
  docs.forEach((d) => {
    console.log("===");
    console.log("invoiceNumber:", d.invoiceNumber);
    console.log("has idempotencyKey field:", Object.prototype.hasOwnProperty.call(d, "idempotencyKey"));
    console.log("idempotencyKey value:", d.idempotencyKey === undefined ? "undefined/absent" : JSON.stringify(d.idempotencyKey));
    console.log("has termKey field:", Object.prototype.hasOwnProperty.call(d, "termKey"));
    console.log("termKey value:", d.termKey === undefined ? "undefined/absent" : JSON.stringify(d.termKey));
    console.log("has membershipStartDate:", Object.prototype.hasOwnProperty.call(d, "membershipStartDate"), d.membershipStartDate);
    console.log("has membershipExpiryDate:", Object.prototype.hasOwnProperty.call(d, "membershipExpiryDate"), d.membershipExpiryDate);
    console.log("has operationType:", Object.prototype.hasOwnProperty.call(d, "operationType"), d.operationType);
  });
  await mongoose.disconnect();
})();