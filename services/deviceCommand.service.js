const DeviceCommand = require("../models/deviceCommand.model");

const GATE_RESTRICTION_COMMAND = "DATA UPDATE OPTIONS AccessRuleType=0,LockOn=15,Door1CancelKeepOpenTime=0";

const RESTRICTION_REASONS = ["ineligible", "expired", "payment_pending", "branch_mismatch"];

const MAX_ALLOCATE_ATTEMPTS = 3;

function isE11000(err) {
  return err && (err.code === 11000 || (err.code !== undefined && err.name === "MongoServerError" && err.code === 11000));
}

async function enqueueCommand({ serialNumber, commandString, status = "pending" }) {
  if (!serialNumber || !commandString) {
    throw new Error("serialNumber and commandString are required to enqueue a device command");
  }

  for (let attempt = 0; attempt < MAX_ALLOCATE_ATTEMPTS; attempt++) {
    const commandId = await DeviceCommand.getNextCommandId(serialNumber);
    try {
      return await DeviceCommand.create({ serialNumber, commandId, commandString, status });
    } catch (err) {
      if (isE11000(err)) continue;
      throw err;
    }
  }

  throw new Error(`Failed to allocate a unique commandId for device ${serialNumber}`);
}

async function dequeuePendingCommand(serialNumber) {
  if (!serialNumber) return null;
  const command = await DeviceCommand.findOne({ serialNumber, status: "pending" }).sort({ commandId: 1 });
  if (!command) return null;
  command.status = "sent";
  await command.save();
  return command;
}

async function acknowledgeCommand({ serialNumber, commandId, returnCode, rawBody }) {
  const query = { commandId };
  if (serialNumber) query.serialNumber = serialNumber;

  const command = await DeviceCommand.findOne(query);
  if (!command) return null;

  command.status = String(returnCode) === "0" ? "executed" : "failed";
  if (rawBody !== undefined) command.responseRaw = String(rawBody).slice(0, 2000);
  await command.save();
  return command;
}

async function enqueueRestrictionCommand(scanner, reason) {
  if (!scanner || !scanner.serial || !RESTRICTION_REASONS.includes(reason)) return null;
  try {
    const command = await enqueueCommand({
      serialNumber: scanner.serial,
      commandString: GATE_RESTRICTION_COMMAND
    });
    if (command && typeof scanner.logError === "function") {
      await scanner.logError(
        `Gate restriction command queued (id=${command.commandId}) after ${reason}`,
        "info"
      );
    }
    return command;
  } catch (err) {
    const message = err && err.message ? err.message : "unknown enqueue error";
    if (scanner && typeof scanner.logError === "function") {
      await scanner.logError(`Failed to enqueue gate command: ${message}`, "error");
    } else {
      console.error(`[adms] failed to enqueue gate command for ${scanner && scanner.serial}:`, message);
    }
    return null;
  }
}

module.exports = {
  enqueueCommand,
  dequeuePendingCommand,
  acknowledgeCommand,
  enqueueRestrictionCommand,
  GATE_RESTRICTION_COMMAND,
  RESTRICTION_REASONS
};