const fs = require("fs");
const path = require("path");

// Load .env from the server directory — never hardcode credentials.
const serverEnvFile = path.join(__dirname, ".env");
if (fs.existsSync(serverEnvFile)) {
  require("dotenv").config({ path: serverEnvFile });
}

const mongoose = require("mongoose");
const Payment = require("./models/payment.model");

(async () => {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });

  const dbName = mongoose.connection.name;
  console.log("Connected to database:", JSON.stringify(dbName));

  const coll = Payment.collection;

  // ── 1. Report current state of gymId_1_idempotencyKey_1 ──────────────────
  const indexes = await coll.listIndexes().toArray();
  const current = indexes.find((i) => i.name === "gymId_1_idempotencyKey_1");

  if (!current) {
    console.log("Index gymId_1_idempotencyKey_1 does not exist — will create fresh.");
  } else {
    const hasCorrectPartial =
      current.partialFilterExpression &&
      JSON.stringify(current.partialFilterExpression) === JSON.stringify({ idempotencyKey: { $type: "string" } });

    if (hasCorrectPartial) {
      console.log("Index gymId_1_idempotencyKey_1 already correct:");
      console.log("  partialFilterExpression:", JSON.stringify(current.partialFilterExpression));
      await mongoose.disconnect();
      return;
    }

    console.log("Stale index detected — will drop and recreate:");
    console.log("  current:", JSON.stringify({
      unique: current.unique,
      sparse: current.sparse,
      partialFilterExpression: current.partialFilterExpression || null,
    }));
  }

  // ── 2. Drop the stale index (ignore-not-found) ───────────────────────────
  try {
    await coll.dropIndex("gymId_1_idempotencyKey_1");
    console.log("Dropped index gymId_1_idempotencyKey_1");
  } catch (e) {
    if (e.codeName === "IndexNotFound") {
      console.log("Index gymId_1_idempotencyKey_1 did not exist — nothing to drop.");
    } else {
      throw e;
    }
  }

  // ── 3. Recreate with partialFilterExpression ──────────────────────────────
  await coll.createIndex(
    { gymId: 1, idempotencyKey: 1 },
    { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } }
  );
  console.log("Created index gymId_1_idempotencyKey_1 with partialFilterExpression");

  // ── 4. Verify ────────────────────────────────────────────────────────────
  const updated = await coll.listIndexes().toArray();
  const final = updated.find((i) => i.name === "gymId_1_idempotencyKey_1");
  console.log("\n=== Final index definition ===");
  console.log("  name:", final.name);
  console.log("  keys:", JSON.stringify(final.key));
  console.log("  unique:", !!final.unique);
  console.log("  sparse:", !!final.sparse);
  console.log("  partialFilterExpression:", JSON.stringify(final.partialFilterExpression));

  await mongoose.disconnect();
  console.log("\nDone.");
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});