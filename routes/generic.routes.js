const router = require("express").Router();
const { protect, authorize } = require("../middlewares/auth.middleware");
const { branchScope } = require("../middlewares/branchScope.middleware");
const { makeCrud } = require("../controllers/genericCrud.controller");
const { ClassSlot, InventoryItem, Branch, Referral } = require("../models/generic.model");

const entities = {
  "class-slots": makeCrud(ClassSlot, "Class slot"),
  inventory: makeCrud(InventoryItem, "Inventory item"),
  branches: makeCrud(Branch, "Branch"),
  referrals: makeCrud(Referral, "Referral")
};

router.use(protect, branchScope);
router.get("/:entity", authorize("admin", "trainer"), (req, res, next) => entities[req.params.entity]?.list(req, res, next) || next(Object.assign(new Error("Invalid entity"), { statusCode: 404 })));
router.post("/:entity", authorize("admin", "trainer"), (req, res, next) => entities[req.params.entity]?.create(req, res, next) || next(Object.assign(new Error("Invalid entity"), { statusCode: 404 })));
router.put("/:entity/:id", authorize("admin", "trainer"), (req, res, next) => entities[req.params.entity]?.update(req, res, next) || next(Object.assign(new Error("Invalid entity"), { statusCode: 404 })));
router.delete("/:entity/:id", authorize("admin"), (req, res, next) => entities[req.params.entity]?.remove(req, res, next) || next(Object.assign(new Error("Invalid entity"), { statusCode: 404 })));

module.exports = router;
