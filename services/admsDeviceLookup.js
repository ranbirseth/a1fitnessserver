const Scanner = require("../models/scanner.model");

function normalizeSerial(serial) {
  if (serial === undefined || serial === null) return "";
  return String(serial).trim();
}

async function findScannerBySerial(serial) {
  const normalized = normalizeSerial(serial);
  if (!normalized) return null;
  let scanner = await Scanner.findOne({ serial: normalized });
  if (!scanner && normalized !== normalized.toUpperCase()) {
    scanner = await Scanner.findOne({ serial: normalized.toUpperCase() });
  }
  return scanner;
}

module.exports = { findScannerBySerial, normalizeSerial };