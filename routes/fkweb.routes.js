// ============================================================
// FKWEB ROUTES (realtime Biometric RS9n)
//
// The raw-body parser is mounted INSIDE the route rather than in server.js so
// that fkwebErrorHandler, which sits in the same route stack, can convert
// body-parser failures (oversized body, truncated transfer) into a well-formed
// FkWeb ACK instead of Express's default 400/413 response.
//
// The parser is express.raw(), never express.text(). realtime_enroll_data
// appends raw fingerprint template bytes after its JSON envelope, and a UTF-8
// text parser irreversibly replaces those bytes with U+FFFD. Express's global
// express.json() cannot be used either: it only consumes application/json, so
// the octet-stream body would never be populated.
//
// Scope is POST-only and path-exact, so no other route's body handling changes.
// ============================================================

const express = require("express");
const { handleFkWeb, fkwebErrorHandler } = require("../controllers/fkweb.controller");

// Comfortably above the observed 1024-byte enroll block and the ~105-byte
// realtime_glog envelope, while still bounding a hostile or corrupt frame.
const FKWEB_BODY_LIMIT = "2mb";

const router = express.Router();

// Both paths are registered here, not only in server.js. In Express 4,
// app.post("/fkweb", router) builds a Route rather than a mount, so the router
// still sees req.url === "/fkweb" and a router.post("/") alone would 404.
router.post(
  ["/", "/fkweb"],
  express.raw({ type: "*/*", limit: FKWEB_BODY_LIMIT }),
  handleFkWeb,
  fkwebErrorHandler
);

module.exports = router;
module.exports.FKWEB_BODY_LIMIT = FKWEB_BODY_LIMIT;
