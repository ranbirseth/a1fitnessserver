const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    gymId: { type: String, required: true, index: true },
    member: { type: mongoose.Schema.Types.ObjectId, ref: "Member", required: true, index: true },
    plan: { type: mongoose.Schema.Types.ObjectId, ref: "Plan", required: true, index: true },
    amount: { type: Number, required: true, min: 0 },
    date: { type: Date, default: Date.now, required: true },
    method: { type: String, enum: ["cash", "card", "upi", "online"], default: "cash" },
    status: { type: String, enum: ["paid", "pending"], default: "paid", index: true },
    note: String,
    invoiceNumber: { type: String, required: true, index: true },
    invoice: { type: Object, default: {} },
    dueDate: Date,
    membershipExpiryDate: { type: Date }, // Historical snapshots of the membership expiry resulting from THIS transaction (immutable)
    membershipStartDate: { type: Date }, // Historical snapshot of the membership term start resulting from THIS transaction (immutable)
    operationType: { type: String, enum: ["assign", "renew", "upgrade"] }, // auto-generated payment events only
    termKey: { type: String }, // deterministic per-term id: `${memberId}:${planId}:${startISO}`
    idempotencyKey: { type: String }, // optional client-supplied idempotency key for retry safety
    branchCode: { type: String, default: "MAIN", index: true }
  },
  { timestamps: true }
);

paymentSchema.index({ gymId: 1, invoiceNumber: 1 }, { unique: true });
// Sparse unique: legacy payments (which lack these fields) are excluded from the
// constraint, so adding them can never conflict with historical revenue records.
paymentSchema.index(
  { gymId: 1, termKey: 1 },
  {
    unique: true,
    partialFilterExpression: { termKey: { $type: "string" } }
  }
);
paymentSchema.index(
  { gymId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string" } }
  }
);

module.exports = mongoose.model("Payment", paymentSchema);
