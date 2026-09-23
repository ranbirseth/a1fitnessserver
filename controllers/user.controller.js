const User = require("../models/user.model");
const { asyncHandler } = require("../utils/asyncHandler");
const { sendResponse } = require("../utils/response");
const { AppError } = require("../utils/appError");

const sanitizeUser = (user) => ({
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
  status: user.status
});

const getMyProfile = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select("-password -refreshTokens -resetPasswordToken -resetPasswordExpire");
  if (!user) throw new AppError("User not found", 404, "USER_NOT_FOUND");
  sendResponse(res, { message: "Profile fetched", data: sanitizeUser(user) });
});

const updateProfile = asyncHandler(async (req, res) => {
  const { name, phone, email, password, photo, address, emergencyContact } = req.body;
  const user = await User.findById(req.user._id);
  if (!user) throw new AppError("User not found", 404, "USER_NOT_FOUND");

  if (email && email !== user.email) {
    const existing = await User.findOne({ gymId: user.gymId, email: email.toLowerCase().trim(), _id: { $ne: user._id } });
    if (existing) throw new AppError("Email already in use", 409, "EMAIL_ALREADY_EXISTS");
    user.email = email.toLowerCase().trim();
  }

  if (name !== undefined) user.name = name.trim();
  if (phone !== undefined) user.phone = phone.trim();
  if (photo !== undefined) user.photo = photo;
  if (address !== undefined) user.address = address;
  if (emergencyContact !== undefined) user.emergencyContact = emergencyContact;
  if (password) user.password = password;

  await user.save();
  sendResponse(res, { message: "Profile updated successfully", data: sanitizeUser(user) });
});

module.exports = { getMyProfile, updateProfile };
