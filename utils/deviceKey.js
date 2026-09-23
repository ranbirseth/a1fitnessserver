const crypto = require("crypto");

const hashKey = (key) => crypto.createHash("sha256").update(String(key)).digest("hex");

const generateKey = (bytes = 24) => crypto.randomBytes(bytes).toString("hex");

module.exports = { hashKey, generateKey };