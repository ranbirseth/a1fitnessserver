const mongoose = require("mongoose");

const bookingSchema = new mongoose.Schema(
  {
    gymId: { type: String, required: true, index: true },
    classSlot: { type: mongoose.Schema.Types.ObjectId, ref: "ClassSlot", required: true, index: true },
    member: { type: mongoose.Schema.Types.ObjectId, ref: "Member", required: true, index: true },
    status: { type: String, enum: ["booked", "cancelled"], default: "booked", index: true }
  },
  { timestamps: true }
);

bookingSchema.index({ gymId: 1, classSlot: 1, member: 1 }, { unique: true });

module.exports = mongoose.model("Booking", bookingSchema);
