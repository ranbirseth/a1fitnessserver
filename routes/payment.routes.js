const router = require("express").Router();
const { protect, authorize } = require("../middlewares/auth.middleware");
const { branchScope } = require("../middlewares/branchScope.middleware");
const {
  createPayment,
  listPayments,
  getMyPayments,
  pendingDues,
  getInvoice,
  generateInvoicePDF,
  getInvoiceDeliveryStatus,
  sendInvoice,
  createOnlinePaymentIntent,
  confirmOnlinePayment,
  markAsPaid,
  markAsUnpaid
} = require("../controllers/payment.controller");
const { sendReminders } = require("../controllers/reminder.controller");

router.use(protect, branchScope);
router.get("/my-payments", authorize("member"), getMyPayments);
router.get("/", authorize("admin", "trainer"), listPayments);
router.get("/dues", authorize("admin", "trainer"), pendingDues);
router.post("/reminders", authorize("admin"), sendReminders);
router.get("/delivery-status", authorize("admin", "trainer"), getInvoiceDeliveryStatus);
router.get("/:id/invoice", authorize("admin", "trainer", "member"), getInvoice);
router.get("/:id/pdf", authorize("admin", "trainer", "member"), generateInvoicePDF);
router.post("/:id/send", authorize("admin", "trainer"), sendInvoice);
router.patch("/:id/paid", authorize("admin", "trainer"), markAsPaid);
router.patch("/:id/unpaid", authorize("admin", "trainer"), markAsUnpaid);
router.post("/", authorize("admin", "trainer"), createPayment);
router.post("/online/intent", authorize("admin", "trainer", "member"), createOnlinePaymentIntent);
router.post("/online/confirm", authorize("admin", "trainer", "member"), confirmOnlinePayment);

module.exports = router;
