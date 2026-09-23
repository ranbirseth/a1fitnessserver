const Booking = require("../models/booking.model");
const Member = require("../models/member.model");
const { ClassSlot } = require("../models/generic.model");
const { asyncHandler } = require("../utils/asyncHandler");
const { sendResponse } = require("../utils/response");
const { getPagination } = require("../utils/pagination");
const { enforceBranchOwnership } = require("../middlewares/branchScope.middleware");

const getScopedBranchCode = (req) => {
  if (req.user.role !== "superadmin") return (req.user.branchCode || "MAIN").trim().toUpperCase();
  const requested = req.query.branchCode;
  if (requested && requested !== "ALL" && requested !== "all") return requested.trim().toUpperCase();
  return undefined;
};

const findTargetMember = async (req) => {
  const { memberId } = req.body;
  if (req.user.role === "member") {
    if (memberId && (!req.member || String(memberId) !== String(req.member._id))) {
      throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
    }
    return req.member || null;
  }
  const query = memberId ? { _id: memberId } : { user: req.user._id };
  if (req.user.role !== "superadmin") query.gymId = req.gymId;
  return Member.findOne(query);
};

const bookClassSlot = asyncHandler(async (req, res) => {
  const { classSlotId } = req.body;
  const member = await findTargetMember(req);
  if (!member) throw Object.assign(new Error("Member not found"), { statusCode: 404 });
  if (!enforceBranchOwnership(member.branchCode, req)) {
    throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
  }
  // Trainer isolation: trainers may only book for their assigned members.
  if (req.user.role === "trainer") {
    if (!member.trainer || String(member.trainer) !== String(req.user._id)) {
      throw Object.assign(new Error("You can only book classes for members assigned to you"), { statusCode: 403 });
    }
  }

  const slotQuery = { _id: classSlotId };
  if (req.user.role !== "superadmin") slotQuery.gymId = req.gymId;
  const slot = await ClassSlot.findOne(slotQuery);
  if (!slot || String(slot.gymId) !== String(member.gymId)) {
    throw Object.assign(new Error("Class slot not found"), { statusCode: 404 });
  }

  const booking = await Booking.create({ classSlot: slot._id, member: member._id, gymId: member.gymId });
  sendResponse(res, { status: 201, message: "Class slot booked", data: booking });
});

const listBookings = asyncHandler(async (req, res) => {
  const { skip, limit, page } = getPagination(req.query);
  let filter;
  if (req.user.role === "member") {
    filter = req.member ? { gymId: req.gymId, member: req.member._id } : { _id: null };
  } else {
    const memberQuery = { gymId: req.gymId };
    const branchCode = getScopedBranchCode(req);
    if (branchCode) memberQuery.branchCode = branchCode;
    // Trainer isolation: trainers only see bookings for their assigned members.
    if (req.user.role === "trainer") {
      memberQuery.trainer = req.user._id;
    }
    const memberIds = (await Member.find(memberQuery).select("_id").lean()).map((m) => m._id);
    filter = { gymId: req.gymId, member: { $in: memberIds } };
  }
  const [items, total] = await Promise.all([
    Booking.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate("classSlot member"),
    Booking.countDocuments(filter)
  ]);
  sendResponse(res, { message: "Bookings fetched", data: { items, total, page, limit } });
});

const cancelBooking = asyncHandler(async (req, res) => {
  const booking = await Booking.findById(req.params.id);
  if (!booking) throw Object.assign(new Error("Booking not found"), { statusCode: 404 });

  const owner = await Member.findById(booking.member).select("gymId branchCode").lean();
  if (!owner || (req.user.role !== "superadmin" && owner.gymId !== req.gymId)) {
    throw Object.assign(new Error("Booking not found"), { statusCode: 404 });
  }
  if (req.user.role === "member") {
    if (!req.member || !booking.member.equals(req.member._id)) {
      throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
    }
  } else if (!enforceBranchOwnership(owner.branchCode, req)) {
    throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
  }
  // Trainer isolation: trainers may only cancel bookings for their assigned members.
  if (req.user.role === "trainer") {
    const bookingMember = await Member.findById(booking.member).select("trainer").lean();
    if (!bookingMember || !bookingMember.trainer || String(bookingMember.trainer) !== String(req.user._id)) {
      throw Object.assign(new Error("You can only cancel bookings for members assigned to you"), { statusCode: 403 });
    }
  }

  booking.status = "cancelled";
  await booking.save();
  sendResponse(res, { message: "Booking cancelled", data: booking });
});

module.exports = { bookClassSlot, listBookings, cancelBooking };
