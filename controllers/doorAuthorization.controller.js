const { asyncHandler } = require("../utils/asyncHandler");
const { sendResponse } = require("../utils/response");
const { AppError } = require("../utils/appError");
const { redeemDoorAuthorization } = require("../services/doorAuthorization.service");

const redeem = asyncHandler(async (req, res) => {
  const scanner = req.scanner;
  const controller = req.controller;
  const token = req.body && req.body.token;

  const result = await redeemDoorAuthorization({ scanner, token, controller });
  if (!result.authorized) {
    throw new AppError("Door authorization is invalid, expired, or already used", 403);
  }

  sendResponse(res, {
    message: "Door authorization accepted",
    data: { authorized: true, expiresAt: result.expiresAt }
  });
});

module.exports = { redeem };
