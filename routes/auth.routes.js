const router = require("express").Router();
const { signup, login, refresh, logout, forgotPassword, resetPassword, demoStatus, demoLogin } = require("../controllers/auth.controller");
const { validate } = require("../middlewares/validate.middleware");
const { signupSchema, loginSchema, refreshSchema, forgotPasswordSchema, resetPasswordSchema } = require("../validations/auth.validation");

router.post("/signup", validate(signupSchema), signup);
router.post("/login", validate(loginSchema), login);
router.post("/refresh", validate(refreshSchema), refresh);
router.post("/logout", validate(refreshSchema), logout);

// DEMO MODE (temporary). Both are inert (404 / demoMode:false) unless the
// server runs with DEMO_MODE=true. No validation schema needed - no body.
router.get("/demo-status", demoStatus);
router.post("/demo-login", demoLogin);

router.post("/forgot-password", validate(forgotPasswordSchema), forgotPassword);
router.post("/reset-password/:token", validate(resetPasswordSchema), resetPassword);

module.exports = router;
