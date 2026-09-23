const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    type: { type: String, enum: ["expiry", "payment", "general"], default: "general" },
    isRead: { type: Boolean, default: false },
    // Deduplication / provenance fields for expiry reminders.
    // member + expiryDate + reminderDate + type form the reminder identity.
    member: { type: mongoose.Schema.Types.ObjectId, ref: "Member", index: true },
    plan: { type: mongoose.Schema.Types.ObjectId, ref: "Plan", index: true },
    expiryDate: { type: Date },
    reminderDate: { type: Date, index: true },
    channel: { type: String, enum: ["inApp", "whatsapp"], default: "inApp" },
    // WhatsApp-delivery provenance. Populated ONLY after Meta accepts the
    // message (a message id was returned for THIS request). metaMessageId is
    // not secret (it is a Meta-assigned message id, not a token).
    provider: { type: String, default: null },
    metaMessageId: { type: String, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model("Notification", notificationSchema);
