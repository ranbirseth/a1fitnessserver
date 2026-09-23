const User = require("../models/user.model");

/**
 * One-time idempotent migration: BUG-04 made member email optional. The
 * gymId/email unique index must be a PARTIAL index so members created without
 * an email are excluded from the constraint (multiple email-less members may
 * coexist) while members with a real string email stay unique per gym.
 *
 * Sparse was the original attempt but does NOT work on the target Atlas
 * MongoDB 8.0.x: sparse still indexes a missing email as null and rejects the
 * second email-less member with E11000. PartialFilterExpression fixes that.
 *
 * Changing the schema declaration alone does NOT update an existing MongoDB
 * index. This migrates any legacy `gymId_1_email_1` (non-sparse or sparse) by
 * dropping it and letting `syncIndexes()` recreate the partial version. Safe
 * to run on every boot and never touches unrelated indexes.
 */
const migrateUserEmailIndex = async () => {
  const coll = User.collection;
  const indexes = await coll.listIndexes().toArray();

  const idx = indexes.find((i) => i.name === "gymId_1_email_1" && i.unique);
  if (!idx) {
    console.log("userIndex: no gymId_1_email_1 index to migrate");
    return;
  }

  const hasPartialFilter =
    idx.partialFilterExpression &&
    idx.partialFilterExpression.email &&
    idx.partialFilterExpression.email["$type"] === "string";

  if (hasPartialFilter) {
    console.log("userIndex: gymId_1_email_1 already partialFilterExpression { email: $type string }, nothing to do");
    return;
  }

  await coll.dropIndex("gymId_1_email_1");
  console.log("userIndex: dropped legacy gymId_1_email_1 index; recreating with partial filter");

  await User.syncIndexes();
  console.log("userIndex: syncIndexes complete");
};

module.exports = { migrateUserEmailIndex };
