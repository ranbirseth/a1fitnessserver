const router = require("express").Router();
const { protect } = require("../middlewares/auth.middleware");
const { validate } = require("../middlewares/validate.middleware");
const { getMyProfile, updateProfile } = require("../controllers/user.controller");
const { updateProfileSchema } = require("../validations/user.validation");

router.use(protect);
router.get("/me", getMyProfile);
router.put("/update-profile", validate(updateProfileSchema), updateProfile);

module.exports = router;
