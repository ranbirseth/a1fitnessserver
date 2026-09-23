const mongoose = require("mongoose");

const DEVICE_COMMAND_STATUSES = ["pending", "sent", "executed", "failed"];

const deviceCommandSchema = new mongoose.Schema(
  {
    serialNumber: { type: String, required: true, trim: true, index: true },
    commandId: { type: Number, required: true },
    commandString: { type: String, required: true },
    status: {
      type: String,
      enum: DEVICE_COMMAND_STATUSES,
      default: "pending",
      index: true
    },
    responseRaw: { type: String, default: "" }
  },
  { timestamps: true }
);

deviceCommandSchema.index({ serialNumber: 1, commandId: 1 }, { unique: true });
deviceCommandSchema.index({ status: 1, serialNumber: 1, commandId: 1 });

deviceCommandSchema.statics.getNextCommandId = async function (serialNumber) {
  const last = await this.findOne({ serialNumber })
    .sort({ commandId: -1 })
    .select({ commandId: 1 })
    .lean();
  return (last && Number.isInteger(last.commandId) ? last.commandId : 0) + 1;
};

module.exports = mongoose.model("DeviceCommand", deviceCommandSchema);
module.exports.DEVICE_COMMAND_STATUSES = DEVICE_COMMAND_STATUSES;