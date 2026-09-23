const mongoose = require("mongoose");

const genericSchema = new mongoose.Schema(
  {
    gymId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: String,
    metadata: { type: Object, default: {} }
  },
  { timestamps: true }
);

const ClassSlot = mongoose.model("ClassSlot", genericSchema.clone());
const InventoryItem = mongoose.model("InventoryItem", genericSchema.clone());
const branchSchema = new mongoose.Schema(
  {
    gymId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    branchCode: { type: String, default: "MAIN", trim: true, uppercase: true },
    description: String,
    address: String,
    phone: String,
    email: String,
    manager: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    status: { type: String, enum: ["active", "inactive"], default: "active", index: true },
    metadata: { type: Object, default: {} }
  },
  { timestamps: true }
);
branchSchema.index({ gymId: 1, branchCode: 1 }, { unique: true });
const Branch = mongoose.model("Branch", branchSchema);
const Referral = mongoose.model("Referral", genericSchema.clone());

module.exports = { ClassSlot, InventoryItem, Branch, Referral };
