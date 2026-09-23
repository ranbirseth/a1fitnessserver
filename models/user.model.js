const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema(
  {
    gymId: { type: String, required: true, index: true }, // Multi-tenant ID
    branchCode: { type: String, default: "MAIN", index: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    password: { type: String, minlength: 6 },
    role: { type: String, enum: ["superadmin", "admin", "trainer", "member"], default: "member", index: true },
    photo: String,
    status: { type: String, enum: ["pending", "active", "inactive"], default: "active", index: true },
    specialty: { type: String, trim: true },
    address: { type: String, trim: true },
    emergencyContact: { type: String, trim: true },
    refreshTokens: [{ type: String }],
    resetPasswordToken: { type: String },
    resetPasswordExpire: { type: Date }
  },
  { timestamps: true }
);

// Partial unique: members without an email (RN dashboard login not required) are
// EXCLUDED from the constraint, so any number of email-less members can coexist,
// while members with a real (string) email stay unique within the gym.
// Note: sparse does not work here on the target Atlas MongoDB 8.0.x (missing
// email is still indexed as null and rejects the 2nd email-less member).
userSchema.index(
  { gymId: 1, email: 1 },
  {
    unique: true,
    partialFilterExpression: { email: { $type: "string" } }
  }
);

userSchema.pre("save", async function preSave(next) {
  if (!this.isModified("password")) return next();
  if (!this.password) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

userSchema.methods.comparePassword = function comparePassword(input) {
  return bcrypt.compare(input, this.password);
};

module.exports = mongoose.model("User", userSchema);
