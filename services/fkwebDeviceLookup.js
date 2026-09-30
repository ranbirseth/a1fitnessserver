// ============================================================
// FKWEB DEVICE LOOKUP (realtime Biometric RS9n)
//
// Resolves the registered Scanner document from the FkWeb `dev_id` header.
//
// This deliberately does NOT import services/admsDeviceLookup.js. That module is
// a protected K30 file, and keeping the RS9n lookup independent guarantees the
// K30 serial-lookup behaviour can never be perturbed by RS9n traffic. The two
// implementations are intentionally near-identical because both resolve a
// device to its registered Scanner record; the only addition here is a
// lowercase retry alongside the existing uppercase one.
//
// The branchCode and gymId used to process an event always come from the
// document returned here. Nothing in the RS9n request is ever trusted for
// branch selection.
// ============================================================

const Scanner = require("../models/scanner.model");

function normalizeDevId(devId) {
  if (devId === undefined || devId === null) return "";
  return String(devId).trim();
}

/**
 * Finds the registered Scanner whose serial matches the FkWeb dev_id.
 * Backs onto the sparse unique index on Scanner.serial (scanner.model.js:52).
 *
 * @returns {Promise<object|null>} the Scanner document, or null when the device
 *   has not been registered.
 */
async function findScannerByDevId(devId) {
  const normalized = normalizeDevId(devId);
  if (!normalized) return null;

  let scanner = await Scanner.findOne({ serial: normalized });

  if (!scanner && normalized !== normalized.toUpperCase()) {
    scanner = await Scanner.findOne({ serial: normalized.toUpperCase() });
  }

  if (!scanner && normalized !== normalized.toLowerCase()) {
    scanner = await Scanner.findOne({ serial: normalized.toLowerCase() });
  }

  return scanner || null;
}

module.exports = { normalizeDevId, findScannerByDevId };
