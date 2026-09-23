const User = require("../models/user.model");
const jwt = require("jsonwebtoken");
const { asyncHandler } = require("../utils/asyncHandler");
const { sendResponse } = require("../utils/response");
const { signAccessToken, signRefreshToken } = require("../utils/tokens");
const { AppError } = require("../utils/appError");

const toTokens = (user) => {
  const payload = { sub: user._id, role: user.role };
  return {
    accessToken: signAccessToken(payload),
    refreshToken: signRefreshToken(payload)
  };
};

const sanitizeUser = (user, member = null) => ({
  _id: user._id,
  gymId: user.gymId,
  branchCode: user.branchCode || "MAIN",
  name: user.name,
  email: user.email,
  phone: user.phone,
  role: user.role,
  photo: user.photo,
  address: user.address,
  emergencyContact: user.emergencyContact,
  status: member ? member.status : user.status,
  paymentStatus: member ? member.paymentStatus : "paid", // Admins/Trainers are always "paid"
  secretCode: member ? member.secretCode : undefined
});

const updateProfile = asyncHandler(async (req, res) => {
  const { name, email, phone, password, photo, address, emergencyContact } = req.body;
  const userId = req.user.sub;

  const user = await User.findById(userId);
  if (!user) throw new AppError("User not found", 404);

  // Check if email is being changed and if it's already taken
  if (email && email !== user.email) {
    const existingUser = await User.findOne({ email, gymId: user.gymId });
    if (existingUser) throw new AppError("Email already in use", 400);
    user.email = email;
  }

  if (name) user.name = name;
  if (phone) user.phone = phone;
  if (password) user.password = password;
  if (photo) user.photo = photo;
  if (address !== undefined) user.address = address;
  if (emergencyContact !== undefined) user.emergencyContact = emergencyContact;

  await user.save();

  // If user is a member, fetch their member details for sanitization
  let member = null;
  if (user.role === "member") {
    member = await Member.findOne({ user: user._id });
  }

  sendResponse(res, { 
    message: "Profile updated successfully", 
    data: sanitizeUser(user, member) 
  });
});

const Member = require("../models/member.model");

const signup = asyncHandler(async (req, res) => {
  const { gymId, name, email, phone, password } = req.body;

  const user = await User.create({
    gymId,
    name,
    email,
    phone,
    password,
    role: "member",
    status: "pending"
  });
  
  let member = null;
  // Create the Member profile with pending status for all signups
  const secretCodeGenerator = async () => {
    let secretCode;
    let exists = true;
    while (exists) {
      secretCode = Math.floor(100 + Math.random() * 900).toString();
      const existing = await Member.findOne({ secretCode });
      if (!existing) exists = false;
    }
    return secretCode;
  };

  const secretCode = await secretCodeGenerator();

  member = await Member.create({
    gymId,
    user: user._id,
    branchCode: "MAIN",
    isActivePlan: false,
    status: "pending",
    paymentStatus: "pending",
    secretCode
  });

  const tokens = toTokens(user);
  user.refreshTokens.push(tokens.refreshToken);
  await user.save();
  
  res.cookie("refreshToken", tokens.refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  });

  sendResponse(res, { status: 201, message: "Signup successful", data: { user: sanitizeUser(user, member), accessToken: tokens.accessToken } });
});

const login = asyncHandler(async (req, res) => {
  const { gymId, email, password, role } = req.body;
  const query = { gymId, email };
  if (role) query.role = role;

  const user = await User.findOne(query);
  if (!user || !(await user.comparePassword(password))) {
    throw new AppError("Invalid credentials", 401, "INVALID_CREDENTIALS");
  }

  // Check if user account is deactivated
  if (user.status === "inactive") {
    throw new AppError("Your account has been deactivated. Please contact admin.", 403, "ACCOUNT_INACTIVE");
  }
  
  let member = null;
  // If user is a member, check approval status
  if (user.role === "member") {
    member = await Member.findOne({ user: user._id });
    if (member && member.status !== "active") {
      const message = member.status === "pending"
        ? "Your account is pending approval. Please wait for admin approval."
        : "Your account is inactive. Please contact admin.";
      throw new AppError(message, 403, "ACCOUNT_INACTIVE");
    }
  }

  const tokens = toTokens(user);
  user.refreshTokens.push(tokens.refreshToken);
  await user.save();
  
  res.cookie("refreshToken", tokens.refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 7 * 24 * 60 * 60 * 1000
  });

  sendResponse(res, { message: "Login successful", data: { user: sanitizeUser(user, member), accessToken: tokens.accessToken, refreshToken: tokens.refreshToken } });
});

const refresh = asyncHandler(async (req, res) => {
  const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken;
  if (!refreshToken) throw new AppError("Refresh token required", 401, "REFRESH_TOKEN_REQUIRED");
  
  let decoded;
  try {
    decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
  } catch {
    throw new AppError("Invalid refresh token", 401, "INVALID_REFRESH_TOKEN");
  }
  
  const user = await User.findById(decoded.sub);
  if (!user || !user.refreshTokens.includes(refreshToken)) {
    throw new AppError("Refresh token revoked", 401, "REFRESH_TOKEN_REVOKED");
  }
  
  const tokens = toTokens(user);
  user.refreshTokens = user.refreshTokens.slice(-4);
  user.refreshTokens.push(tokens.refreshToken);
  await user.save();
  
  res.cookie("refreshToken", tokens.refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 7 * 24 * 60 * 60 * 1000
  });

  sendResponse(res, { message: "Token refreshed", data: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken } });
});

const logout = asyncHandler(async (req, res) => {
  const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken;
  if (!refreshToken) throw new AppError("Refresh token required for logout", 401, "REFRESH_TOKEN_REQUIRED");
  
  let decoded;
  try {
    decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
  } catch {
    res.clearCookie("refreshToken");
    return sendResponse(res, { message: "Logout successful", data: {} });
  }
  
  const user = await User.findById(decoded.sub);
  if (user) {
    user.refreshTokens = user.refreshTokens.filter((t) => t !== refreshToken);
    await user.save();
  }
  
  res.clearCookie("refreshToken");
  sendResponse(res, { message: "Logout successful", data: {} });
});

// ============================================================
// DEMO MODE (TEMPORARY - environment controlled)
// ============================================================
// When DEMO_MODE=true, /api/auth/demo-login signs visitors in as the
// seeded MAIN gym admin WITHOUT credentials by issuing REAL access and
// refresh tokens through the exact same pipeline as `login`.
// Everything else stays untouched: JWT verification, refresh-token
// rotation, RBAC (authorize), branchScope and gym isolation all remain
// fully enforced for demo sessions.
//
// DEMO_MODE=false (or unset) -> both routes behave as if they do not
// exist and normal login/authentication is required again.
// The flag is read at REQUEST time, so it can never get hardcoded into
// the running app - flipping the env var + restart restores security.

const isDemoModeEnabled = () =>
  String(process.env.DEMO_MODE || "").trim().toLowerCase() === "true";

const DEMO_GYM_ID = process.env.DEMO_GYM_ID || "MAIN";

const DEMO_ACCOUNTS = {
  superadmin: { email: "superadmin@dev.local", password: "superadmin2026" },
  admin:      { email: "admin@gmail.com",       password: "admin2026" },
  trainer:    { email: "trainer@dev.local",      password: "trainer2026" },
  member:     { email: "member@dev.local",       password: "member2026" },
};

const demoStatus = asyncHandler(async (_req, res) => {
  sendResponse(res, {
    message: "Demo mode status",
    data: { demoMode: isDemoModeEnabled() },
  });
});

const demoLogin = asyncHandler(async (req, res) => {
  // Hard runtime gate: disabled unless DEMO_MODE is exactly "true".
  if (!isDemoModeEnabled()) {
    throw new AppError("Not Found", 404);
  }

  const role = req.body?.role || "admin";
  const account = DEMO_ACCOUNTS[role];
  if (!account) {
    throw new AppError("Invalid demo role", 400);
  }

// dev accounts are seeded in the DB at startup, but if they get deleted or deactivated, we can self-heal them here.
  let user = await User.findOne({
    email: account.email,
    gymId: DEMO_GYM_ID,
    role,
  });

  if (!user) {
    user = await User.findOne({ gymId: DEMO_GYM_ID, role, status: "active" });
  }

  if (!user) {
    console.warn(`[DEMO MODE] No ${role} found. Recreating...`);
    user = await User.create({
      gymId: DEMO_GYM_ID,
      name: `Dev ${role.charAt(0).toUpperCase() + role.slice(1)}`,
      email: account.email,
      password: account.password,
      role,
      status: "active",
      branchCode: "MAIN",
    });
  }

  // Self-heal deactivated demo accounts.
  if (user.status === "inactive") {
    user.status = "active";
  }

  // Members require a Member document for sanitizeUser.
  let member = null;
  if (role === "member") {
    member = await Member.findOne({ user: user._id });
    if (!member) {
      member = await Member.create({
        gymId: DEMO_GYM_ID,
        user: user._id,
        branchCode: "MAIN",
        isActivePlan: true,
        status: "active",
        paymentStatus: "paid",
        secretCode: Math.floor(100 + Math.random() * 900).toString(),
      });
    } else if (member.status !== "active") {
      member.status = "active";
      member.paymentStatus = "paid";
      await member.save();
    }
  }

  const tokens = toTokens(user);
  user.refreshTokens.push(tokens.refreshToken);
  user.refreshTokens = user.refreshTokens.slice(-10);
  await user.save();

  res.cookie("refreshToken", tokens.refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  sendResponse(res, {
    message: "Demo login successful",
    data: { user: sanitizeUser(user, member), accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },
  });
});

const crypto = require("crypto");

const forgotPassword = asyncHandler(async (req, res) => {
  const { email, gymId } = req.body;
  const user = await User.findOne({ email, gymId });
  
  if (!user) {
    // For security reasons, don't reveal if user exists
    return sendResponse(res, { message: "If your email is registered, you will receive a reset link shortly." });
  }

  // Generate token
  const resetToken = crypto.randomBytes(32).toString("hex");
  user.resetPasswordToken = crypto.createHash("sha256").update(resetToken).digest("hex");
  user.resetPasswordExpire = Date.now() + 3600000; // 1 hour
  await user.save();

  // In production, send email. In development, log to console.
  const resetUrl = `${process.env.CLIENT_URL || "http://localhost:5173"}/reset-password/${resetToken}`;
  console.log(`[PASSWORD_RESET_DEBUG] Link for ${email}: ${resetUrl}`);

  sendResponse(res, { message: "If your email is registered, you will receive a reset link shortly." });
});

const resetPassword = asyncHandler(async (req, res) => {
  const { token } = req.params;
  const { password } = req.body;

  const hashedToken = crypto.createHash("sha256").update(token).digest("hex");
  const user = await User.findOne({
    resetPasswordToken: hashedToken,
    resetPasswordExpire: { $gt: Date.now() }
  });

  if (!user) throw new AppError("Invalid or expired reset token", 400, "INVALID_TOKEN");

  user.password = password;
  user.resetPasswordToken = undefined;
  user.resetPasswordExpire = undefined;
  await user.save();

  sendResponse(res, { message: "Password reset successful" });
});

module.exports = { signup, login, refresh, logout, forgotPassword, resetPassword, updateProfile, demoStatus, demoLogin };
