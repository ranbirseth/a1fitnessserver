const router = require("express").Router();
const { protect, authorize, adminOnly } = require("../middlewares/auth.middleware");
const { authenticateDevice } = require("../middlewares/scannerAuth.middleware");
const { ingestEvents, heartbeat } = require("../controllers/scannerEvents.controller");
const {
  getScanners,
  createScanner,
  getScannerById,
  updateScanner,
  deleteScanner,
  rotateScannerKey,
  activateFkwebCutoff,
  getSyncPayload,
  pingScanner
} = require("../controllers/scanner.controller");

// Device ingestion (authenticated by device key, no user session)
router.post("/events", authenticateDevice, ingestEvents);
router.post("/heartbeat", authenticateDevice, heartbeat);

// Reads: superadmin is read-only (all branches), branch admins scoped to own branch
router.get("/", protect, authorize("admin", "superadmin"), getScanners);
router.get("/:id", protect, authorize("admin", "superadmin"), getScannerById);

// Mutations: branch admins only. Superadmin gets 403 via adminOnly.
router.post("/", protect, adminOnly, createScanner);
router.patch("/:id", protect, adminOnly, updateScanner);
router.delete("/:id", protect, adminOnly, deleteScanner);
router.post("/:id/rotate-key", protect, adminOnly, rotateScannerKey);
// Sets the RS9n historical-log cutoff (Scanner.fkwebAcceptAfter). Behind the
// same authenticated branch-admin guard as every other scanner mutation: an
// unauthenticated caller can never move the attendance boundary. An explicit
// timestamp is required, so activation is always an auditable operator action.
router.post("/:id/fkweb-activate", protect, adminOnly, activateFkwebCutoff);
router.get("/:id/sync-payload", protect, adminOnly, getSyncPayload);
router.post("/:id/ping", protect, authorize("admin", "superadmin"), pingScanner);

module.exports = router;