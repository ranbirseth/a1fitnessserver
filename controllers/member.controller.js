const Member = require("../models/member.model");
const User = require("../models/user.model");
const Plan = require("../models/plan.model");
const PlanBranch = require("../models/planBranch.model");
const Payment = require("../models/payment.model");
const Attendance = require("../models/attendance.model");
const Progress = require("../models/progress.model");
const Notification = require("../models/notification.model");
const WorkoutPlan = require("../models/workout.model");
const DietPlan = require("../models/diet.model");
const AuditLog = require("../models/audit.model");
const mongoose = require("mongoose");
const { asyncHandler } = require("../utils/asyncHandler");
const { sendResponse } = require("../utils/response");
const { getPagination } = require("../utils/pagination");
const { enforceBranchOwnership } = require("../middlewares/branchScope.middleware");

// ── Trainer assignment guard ──────────────────────────────────────────────
// For the Trainer role, member access MUST be restricted to ONLY the members
// assigned to that authenticated Trainer (Member.trainer === req.user._id).
// Admin / superadmin bypass this check. The branch check (enforceBranchOwnership)
// is applied *in addition to* this, not replaced by it.
const assertTrainerAssignment = (req, member) => {
  if (!req.user) return;
  if (req.user.role !== "trainer") return;
  if (!member.trainer || String(member.trainer) !== String(req.user._id)) {
    throw Object.assign(
      new Error("You can only access members assigned to you"),
      { statusCode: 403 }
    );
  }
};

const calculateExpiry = (startDate, durationDays) => {
  const expiry = new Date(startDate);
  expiry.setDate(expiry.getDate() + parseInt(durationDays));
  return expiry;
};

const isPlanActive = (expiryDate, paymentStatus) => {
  return paymentStatus === "paid" && new Date() < new Date(expiryDate);
};

const generateUniqueSecretCode = async () => {
  let code;
  let exists = true;
  while (exists) {
    code = Math.floor(100 + Math.random() * 900).toString();
    const existing = await Member.findOne({ secretCode: code });
    if (!existing) exists = false;
  }
  return code;
};

const resolveValidTrainer = async (trainerId, branchCode, gymId) => {
  if (!trainerId) return null;
  if (!mongoose.Types.ObjectId.isValid(trainerId)) {
    throw Object.assign(new Error("Trainer not found in your gym"), { statusCode: 404 });
  }
  const trainer = await User.findOne({ _id: trainerId, gymId, role: "trainer" });
  if (!trainer) {
    throw Object.assign(new Error("Trainer not found in your gym"), { statusCode: 404 });
  }
  const memberBranch = (branchCode || "MAIN").trim().toUpperCase();
  const trainerBranch = (trainer.branchCode || "MAIN").trim().toUpperCase();
  if (trainerBranch !== memberBranch) {
    throw Object.assign(new Error("Cannot assign a trainer from another branch"), { statusCode: 403 });
  }
  return trainer._id;
};

const validatePlanBranchAccess = async (planId, branchCode, gymId, userRole, session) => {
  if (userRole === "superadmin") return;
  const normalizedBranch = (branchCode || "MAIN").trim().toUpperCase();
  const planBranch = await PlanBranch.findOne({
    gymId,
    planId,
    branchCode: normalizedBranch,
    status: "active"
  }).session(session || null);
  if (!planBranch) {
    throw Object.assign(
      new Error("This plan is not available for your branch. Ask the superadmin to apply it first."),
      { statusCode: 403 }
    );
  }
};

// ── Atomic membership + payment operations ──────────────────────────────────
// Business rule: assigning/renewing/upgrading a membership IS a payment/revenue
// event. The membership mutation and its exactly-one Payment row must commit or
// roll back together inside a single MongoDB transaction, so a retry, a crash
// between two HTTP calls, or a failed payment can never produce:
//   - a membership update with no payment,   or
//   - a payment with no membership update,   or
//   - duplicate revenue for the same term.
//
// Idempotency is backed by two database unique constraints (see Payment model):
//   - `termKey`      deterministic per term  `${memberId}:${planId}:${startISO}`
//   - `idempotencyKey` optional client-supplied key for strong retry semantics
// Both indexes are SPARSE, so pre-existing payments (which lack these fields)
// are untouched and never conflict with the constraint.

const resolvePaymentShape = ({ gymId, member, plan, membershipStartDate, membershipExpiryDate, operationType, body }) => {
  const paymentBody = body && typeof body.payment === "object" && body.payment !== null ? body.payment : {};
  const amount = paymentBody.amount !== undefined ? paymentBody.amount : body.amount !== undefined ? body.amount : plan.price;
  const method = paymentBody.method !== undefined ? paymentBody.method : body.method !== undefined ? body.method : "cash"; // existing app default
  const status = paymentBody.status !== undefined ? paymentBody.status : body.status !== undefined ? body.status : "paid"; // existing app default (web always records paid)
  const note = paymentBody.note !== undefined ? paymentBody.note : body.note !== undefined ? body.note : `Plan ${operationType === "assign" ? "assigned" : operationType === "upgrade" ? "upgraded" : "renewed"} - ${plan.name}`;
  const date = paymentBody.date !== undefined ? paymentBody.date : body.date !== undefined ? body.date : new Date();
  const idempotencyKey = paymentBody.idempotencyKey || body.idempotencyKey || undefined;
  const invoiceNumber = `INV-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const branchCode = (member.branchCode || "MAIN").trim().toUpperCase();
  return {
    gymId,
    member: member._id,
    plan: plan._id,
    amount,
    method,
    status,
    note,
    date,
    invoiceNumber,
    branchCode,
    membershipStartDate,
    membershipExpiryDate,
    operationType,
    termKey: `${member._id}:${plan._id}:${new Date(membershipStartDate).toISOString()}`,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    invoice: { invoiceNumber, amount, member: member._id, plan: plan._id, branchCode, createdAt: new Date().toISOString() }
  };
};

// A "replay" is only true when BOTH the Payment row exists AND the member is
// already sitting on the exact same plan + term. This prevents a retried request
// from creating a second payment while still allowing a deliberate re-assign
// (a genuinely new term starts on a different date) to create its own payment.
const memberMatchesTerm = (member, planId, startDate, expiryDate) =>
  String(member.currentPlan || "") === String(planId) &&
  !!member.membershipStartDate &&
  !!member.membershipExpiryDate &&
  new Date(member.membershipStartDate).getTime() === new Date(startDate).getTime() &&
  new Date(member.membershipExpiryDate).getTime() === new Date(expiryDate).getTime();

// Classify a duplicate-key error by which unique index it hit. Only conflicts on
// the idempotency indexes (termKey / idempotencyKey) are treated as a raced
// replay (-> idempotency). Any other duplicate key is rethrown so the real cause
// stays diagnosable instead of being masked as "Payment already exists".
const classifyDuplicateKey = (error) => {
  if (!error || error.code !== 11000 || !error.keyPattern) return null;
  if ("termKey" in error.keyPattern || "idempotencyKey" in error.keyPattern) return "idempotency";
  return "other";
};

const findTermPayment = (gymId, reqKey, memberId, planId, startDate, expiryDate) => {
  const where = reqKey
    ? { gymId, idempotencyKey: reqKey }
    : {
        gymId,
        member: memberId,
        plan: planId,
        membershipStartDate: startDate,
        membershipExpiryDate: expiryDate
      };
  return Payment.findOne(where);
};

const sendReplayResponse = (res, member, payment, operationType) => {
  const verb = operationType === "assign" ? "assigned" : operationType === "upgrade" ? "upgraded" : "renewed";
  sendResponse(res, {
    message: `Plan already ${verb} with payment recorded. Duplicate request ignored.`,
    data: { ...member.toObject(), payment }
  });
};

const runMembershipPaymentOp = async (req, res, operationType, computeTerms) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  const { planId: explicitPlanId, membershipStartDate: requestedStartDate } = req.body;
  const reqKey = typeof req.body.payment === "object" && req.body.payment !== null
    ? (req.body.payment.idempotencyKey || req.body.idempotencyKey)
    : req.body.idempotencyKey;

  let member;
  let plan;
  let startDate;
  let expiryDate;
  let payment;

  try {
    member = await Member.findOne({ _id: req.params.id, gymId: req.gymId }).session(session);
    if (!member) throw Object.assign(new Error("Member not found in your gym"), { statusCode: 404 });
    if (!enforceBranchOwnership(member.branchCode, req)) {
      throw Object.assign(new Error("Member not found in your branch"), { statusCode: 404 });
    }
    assertTrainerAssignment(req, member);

    const planIdToUse = operationType === "renew" ? (explicitPlanId || member.currentPlan) : explicitPlanId;
    plan = await Plan.findOne({ _id: planIdToUse, gymId: req.gymId }).session(session);
    if (!plan) throw Object.assign(new Error("Plan not found"), { statusCode: 404 });
    await validatePlanBranchAccess(plan._id, member.branchCode, req.gymId, req.user.role, session);

    ({ startDate, expiryDate } = computeTerms({ member, plan, requestedStartDate }));

    // Idempotent replay check (retry after timeout, duplicate click, second web call).
    const existing = await findTermPayment(req.gymId, reqKey, member._id, plan._id, startDate, expiryDate).session(session);
    if (existing && memberMatchesTerm(member, plan._id, startDate, expiryDate)) {
      await session.commitTransaction();
      session.endSession();
      return sendReplayResponse(res, member, existing, operationType);
    }

    const paymentData = resolvePaymentShape({
      gymId: req.gymId,
      member,
      plan,
      membershipStartDate: startDate,
      membershipExpiryDate: expiryDate,
      operationType,
      body: req.body
    });

    // Existing membership semantics, unchanged.
    member.currentPlan = plan._id;
    member.membershipStartDate = startDate;
    member.membershipExpiryDate = expiryDate;
    if (member.status === "pending" || member.status === "inactive") {
      member.status = "pending";
    } else {
      member.status = "active";
    }
    if (paymentData.status === "paid") {
      // Mirror createPayment / markAsPaid activation rules exactly.
      member.paymentStatus = "paid";
      if (member.membershipExpiryDate && new Date() < new Date(member.membershipExpiryDate)) {
        member.status = "active";
        member.isActivePlan = true;
      }
    } else {
      member.paymentStatus = "pending";
      member.isActivePlan = false;
    }
    await member.save({ session });

    [payment] = await Payment.create([paymentData], { session });

    // Mirror createPayment's notification so the member sees the same "Payment
    // received/pending" message they get from the standalone payment endpoint.
    await Notification.create([{
      user: member.user,
      title: payment.status === "pending" ? "Payment pending" : "Payment received",
      message: `Invoice ${payment.invoiceNumber} for amount ${payment.amount} (${payment.status})`,
      type: "payment"
    }], { session });

    await session.commitTransaction();
    session.endSession();

    if (req.app.locals.io && operationType === "assign") {
      req.app.locals.io.to(req.gymId).emit("member:updated", {
        memberId: member._id,
        userId: member.user,
        action: "plan_assigned"
      });
    }

    const verb = operationType === "assign" ? "assigned" : operationType === "upgrade" ? "upgraded" : "renewed";
    sendResponse(res, { message: `Plan ${verb} and payment recorded.`, data: { ...member.toObject(), payment } });
  } catch (error) {
    await session.abortTransaction().catch(() => {});
    session.endSession();
    // Only duplicate-key errors targeting the idempotency indexes (termKey or
    // idempotencyKey) are treated as a raced replay. An unrelated duplicate-key
    // error stays diagnosable instead of being bundled into a misleading
    // "Payment already exists" 409.
    if (classifyDuplicateKey(error) === "idempotency") {
      // Duplicate key on termKey/idempotencyKey: two identical requests raced and
      // the winning transaction committed first. Return the winner as a replay.
      const committed = await findTermPayment(req.gymId, reqKey, member?._id, plan?._id, startDate, expiryDate);
      if (committed && member) {
        const freshMember = await Member.findOne({ _id: member._id, gymId: req.gymId });
        if (freshMember && memberMatchesTerm(freshMember, committed.plan, committed.membershipStartDate, committed.membershipExpiryDate)) {
          return sendReplayResponse(res, freshMember, committed, operationType);
        }
      }
      throw Object.assign(new Error("Payment already exists for this membership term. Please retry with a unique idempotency key."), { statusCode: 409 });
    }
    throw error;
  }
};

const createMember = asyncHandler(async (req, res) => {
  // Optional "Initial Plan" workflow: when the caller supplies a `planId`
  // together with payment details, creating the member ALSO creates an
  // initial plan assignment and its exactly-one Payment atomically, mirroring
  // the Assign/Renew/Upgrade semantics (CREATE MEMBER + BUY PLAN). Without a
  // `planId`, the member is created with no plan and a pending payment state,
  // preserving the legacy behavior untouched.
  const {
    name,
    email,
    phone,
    password,
    trainerId,
    branchCode = "MAIN",
    planId,
    membershipStartDate
  } = req.body;
  const photo = req.file ? `/uploads/${req.file.filename}` : undefined;
  const gymId = req.gymId;

  // WhatsApp/phone number is required for new members: membership reminders are
  // delivered to it. Validation is enforced only at member creation so existing
  // valid records (created before this rule) are preserved untouched.
  const normalizedPhone = phone ? String(phone).trim() : "";
  const phoneDigits = normalizedPhone.replace(/\D/g, "");
  if (!normalizedPhone || phoneDigits.length < 10) {
    throw Object.assign(
      new Error("A valid phone/WhatsApp number is required to create a member"),
      { statusCode: 400 }
    );
  }

  const scopedBranchCode = req.user.role === "superadmin"
    ? (branchCode || "MAIN").trim().toUpperCase()
    : (req.user.branchCode || "MAIN").trim().toUpperCase();

  const normalizedEmail = email ? String(email).toLowerCase().trim() : "";

  if (normalizedEmail) {
    const existingUser = await User.findOne({ gymId, email: normalizedEmail });
    if (existingUser) {
      throw Object.assign(new Error("A member with this email already exists in this gym"), { statusCode: 409 });
    }
  }

  const wantsPlan = !!planId;

  // The member + initial-payment must commit or roll back together: a member
  // must never be left with a plan but no payment. MongoDB transactions are
  // used only when a plan is requested; plain creation needs no transaction.
  const session = wantsPlan ? await mongoose.startSession() : null;
  if (session) session.startTransaction();

  try {
    let plan = null;
    // The membership start date is always the admin-selected admission date
    // (defaulting to today), regardless of whether an initial plan is chosen.
    const startDate = membershipStartDate ? new Date(membershipStartDate) : new Date();
    let expiryDate = null;

    if (wantsPlan) {
      plan = await Plan.findOne({ _id: planId, gymId }).session(session);
      if (!plan) {
        throw Object.assign(new Error("Plan not found in your gym"), { statusCode: 404 });
      }
      await validatePlanBranchAccess(plan._id, scopedBranchCode, gymId, req.user.role, session);
      expiryDate = calculateExpiry(startDate, plan.duration);
    }

    // Always create via the array form so the result is an array whether or not
    // a session/transaction is active; this keeps the branch handling uniform.
    const [user] = await User.create(
      [{
        gymId,
        name,
        phone: normalizedPhone,
        role: "member",
        photo,
        branchCode: scopedBranchCode,
        ...(normalizedEmail ? { email: normalizedEmail } : {}),
        ...(password ? { password } : {})
      }],
      session ? { session } : {}
    );

    const secretCode = await generateUniqueSecretCode();

    const [member] = await Member.create(
      [{
        gymId,
        user: user._id,
        trainer: await resolveValidTrainer(trainerId, scopedBranchCode, gymId),
        currentPlan: wantsPlan ? plan._id : null,
        membershipStartDate: startDate,
        membershipExpiryDate: wantsPlan ? expiryDate : null,
        isActivePlan: false,
        status: "pending",
        paymentStatus: "pending",
        secretCode,
        branchCode: scopedBranchCode
      }],
      session ? { session } : {}
    );

    let payment = null;
    if (wantsPlan) {
      const paymentData = resolvePaymentShape({
        gymId,
        member,
        plan,
        membershipStartDate: startDate,
        membershipExpiryDate: expiryDate,
        operationType: "assign",
        body: req.body
      });

      // Mirror runMembershipPaymentOp / createPayment activation rules exactly.
      if (paymentData.status === "paid") {
        member.paymentStatus = "paid";
        if (new Date() < new Date(expiryDate)) {
          member.status = "active";
          member.isActivePlan = true;
        }
      } else {
        member.paymentStatus = "pending";
        member.isActivePlan = false;
      }
      await member.save({ session });

      [payment] = await Payment.create([paymentData], { session });

      // Mirror runMembershipPaymentOp so the new member sees the same payment
      // notification they would get from the standalone payment endpoint.
      await Notification.create([{
        user: member.user,
        title: payment.status === "pending" ? "Payment pending" : "Payment received",
        message: `Invoice ${payment.invoiceNumber} for amount ${payment.amount} (${payment.status})`,
        type: "payment"
      }], { session });
    }

    if (session) {
      await session.commitTransaction();
      session.endSession();
    }

    sendResponse(res, {
      status: 201,
      message: wantsPlan ? "Member created with initial plan and payment recorded" : "Member created",
      data: wantsPlan ? { ...member.toObject(), payment } : member
    });
  } catch (error) {
    if (session) {
      await session.abortTransaction().catch(() => {});
      session.endSession();
    }
    throw error;
  }
});

const fetchMembers = async (req, query, gymId) => {
  const { skip, limit, page } = getPagination(query);
  const branchFilter = { gymId };

  if (req.user && req.user.role !== "superadmin") {
    branchFilter.branchCode = (req.user.branchCode || "MAIN").trim().toUpperCase();
  } else if (query.branchCode && query.branchCode !== "ALL" && query.branchCode !== "all") {
    branchFilter.branchCode = query.branchCode.trim().toUpperCase();
  }
  
  // Status filter logic
  if (query.status && query.status !== "all") {
    branchFilter.status = query.status;
  }

  // Trainer isolation: Trainers can ONLY see members assigned to them.
  // The trainerId query param is only used by admin/superadmin to view a
  // specific trainer's members. When the caller IS a trainer, we force the
  // filter to their own _id, ignoring any client-supplied trainerId.
  if (req.user && req.user.role === "trainer") {
    branchFilter.trainer = req.user._id;
  } else if (query.trainerId) {
    branchFilter.trainer = new mongoose.Types.ObjectId(query.trainerId);
  }

  const q = query.search
    ? { 
        $or: [
          { "userDoc.name": new RegExp(query.search, "i") }, 
          { "userDoc.email": new RegExp(query.search, "i") },
          { "userDoc.phone": new RegExp(query.search, "i") }
        ] 
      }
    : {};
  const baseLookup = [
    { $lookup: { from: "users", localField: "user", foreignField: "_id", as: "userDoc" } },
    { $unwind: "$userDoc" },
    { $lookup: { from: "users", localField: "trainer", foreignField: "_id", as: "trainerDoc" } },
    { $lookup: { from: "plans", localField: "currentPlan", foreignField: "_id", as: "planDoc" } }
  ];
  const filterStages = [{ $match: branchFilter }, ...(Object.keys(q).length ? [{ $match: q }] : [])];
  const pipeline = [
    ...baseLookup, 
    ...filterStages, 
    { $sort: { createdAt: -1 } }, 
    { $skip: skip }, 
    { $limit: limit },
    {
      $project: {
        _id: 1,
        gymId: 1,
        branchCode: 1,
        isActivePlan: 1,
        membershipStartDate: 1,
        membershipExpiryDate: 1,
        status: 1,
        paymentStatus: 1,
        secretCode: 1,
        createdAt: 1,
        user: {
          _id: "$userDoc._id",
          gymId: "$userDoc.gymId",
          branchCode: "$userDoc.branchCode",
          name: "$userDoc.name",
          email: "$userDoc.email",
          phone: "$userDoc.phone",
          role: "$userDoc.role",
          photo: "$userDoc.photo",
          status: "$userDoc.status",
          specialty: "$userDoc.specialty",
          address: "$userDoc.address",
          emergencyContact: "$userDoc.emergencyContact",
          createdAt: "$userDoc.createdAt",
          updatedAt: "$userDoc.updatedAt"
        },
        trainer: {
          _id: { $arrayElemAt: ["$trainerDoc._id", 0] },
          gymId: { $arrayElemAt: ["$trainerDoc.gymId", 0] },
          branchCode: { $arrayElemAt: ["$trainerDoc.branchCode", 0] },
          name: { $arrayElemAt: ["$trainerDoc.name", 0] },
          email: { $arrayElemAt: ["$trainerDoc.email", 0] },
          phone: { $arrayElemAt: ["$trainerDoc.phone", 0] },
          role: { $arrayElemAt: ["$trainerDoc.role", 0] },
          photo: { $arrayElemAt: ["$trainerDoc.photo", 0] },
          status: { $arrayElemAt: ["$trainerDoc.status", 0] },
          specialty: { $arrayElemAt: ["$trainerDoc.specialty", 0] }
        },
        currentPlan: { $arrayElemAt: ["$planDoc", 0] }
      }
    }
  ];
  const [items, totalObj] = await Promise.all([
    Member.aggregate(pipeline),
    Member.aggregate([...baseLookup, ...filterStages, { $count: "count" }])
  ]);
  return { items, page, limit, total: totalObj[0]?.count || 0 };
};

const listMembers = asyncHandler(async (req, res) => {
  const data = await fetchMembers(req, req.query, req.gymId);
  sendResponse(res, { message: "Members fetched", data });
});

const searchMembers = asyncHandler(async (req, res) => {
  const data = await fetchMembers(req, { ...req.query, search: req.query.q || "" }, req.gymId);
  sendResponse(res, { message: "Members search fetched", data });
});

// Fields that must NEVER be serialized out of a User document in API responses.
const SENSITIVE_USER_FIELDS = "-password -refreshTokens -resetPasswordToken -resetPasswordExpire";

// Staff roles that may read other members' records given the view_member permission.
const canReadOtherMembers = (req) => {
  if (!req.user) return false;
  if (req.user.role === "superadmin") return true;
  const rolePermissions = {
    admin: [
      "create_workout", "assign_workout", "delete_workout", "view_workout",
      "create_diet", "assign_diet", "delete_diet", "view_diet",
      "create_member", "delete_member", "update_member", "view_member", "approve_member",
      "manage_plans", "view_payments", "manage_payments"
    ],
    trainer: [
      "create_workout", "assign_workout", "view_workout", "delete_workout",
      "create_diet", "assign_diet", "view_diet", "delete_diet",
      "create_member", "delete_member", "update_member", "view_member", "approve_member", "manage_plans"
    ]
  };
  return (rolePermissions[req.user.role] || []).includes("view_member");
};

const getMember = asyncHandler(async (req, res) => {
  // MEMBER role: strictly self-only access. A member must never be able to
  // request another member's record, even within the same branch.
  if (req.user && req.user.role === "member") {
    if (!req.member) throw Object.assign(new Error("Member profile not found"), { statusCode: 404 });
    // Reject any request for a record that is not the authenticated member.
    if (String(req.params.id) !== String(req.member._id)) {
      throw Object.assign(new Error("Member not found"), { statusCode: 404 });
    }
    const selfMember = await Member.findById(req.member._id)
      .populate("user", SENSITIVE_USER_FIELDS)
      .populate("trainer", SENSITIVE_USER_FIELDS)
      .populate("currentPlan");
    if (!selfMember) throw Object.assign(new Error("Member profile not found"), { statusCode: 404 });
    return sendResponse(res, { message: "Member fetched", data: selfMember });
  }

  // STAFF (admin/trainer): must hold view_member permission.
  if (!canReadOtherMembers(req)) {
    throw Object.assign(new Error("Forbidden: Insufficient permissions"), { statusCode: 403 });
  }

  const member = await Member.findOne({ _id: req.params.id, gymId: req.gymId })
    .populate("user", SENSITIVE_USER_FIELDS)
    .populate("trainer", SENSITIVE_USER_FIELDS)
    .populate("currentPlan");
  if (!member) throw Object.assign(new Error("Member not found in your gym"), { statusCode: 404 });
  // Branch ownership: admin/trainer can only access members in their own branch.
  if (!enforceBranchOwnership(member.branchCode, req)) {
    throw Object.assign(new Error("Member not found in your branch"), { statusCode: 404 });
  }
  // Trainer isolation: trainers may only view their own assigned members.
  assertTrainerAssignment(req, member);
  sendResponse(res, { message: "Member fetched", data: member });
});

const updateMember = asyncHandler(async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const member = await Member.findOne({ _id: req.params.id, gymId: req.gymId }).session(session);
    if (!member) throw Object.assign(new Error("Member not found in your gym"), { statusCode: 404 });
    if (!enforceBranchOwnership(member.branchCode, req)) {
      throw Object.assign(new Error("Member not found in your branch"), { statusCode: 404 });
    }
    assertTrainerAssignment(req, member);

    const { name, phone, email, password, reason, trainerId, branchCode, ...memberPayload } = req.body;
    
    // Only superadmin can reassign a member's branch
    if (req.user.role === "superadmin" && branchCode) {
      memberPayload.branchCode = branchCode.trim().toUpperCase();
    }
    const photo = req.file ? `/uploads/${req.file.filename}` : undefined;

    const oldMemberValues = member.toObject();
    let oldUserValues = null;

    if (name || phone || email || photo || password || memberPayload.status || memberPayload.branchCode) {
      const user = await User.findById(member.user).session(session);
      if (user) {
        oldUserValues = user.toObject();
        const userUpdate = {
          ...(name && { name }),
          ...(phone && { phone }),
          ...(email && { email: email.toLowerCase().trim() }),
          ...(photo && { photo }),
          ...(password && { password }),
          ...(memberPayload.branchCode && { branchCode: memberPayload.branchCode }),
        };

        if (memberPayload.status === 'inactive') {
          user.status = 'inactive';
          user.refreshTokens = []; // Immediate session termination
        } else if (memberPayload.status === 'active') {
          user.status = 'active';
        }

        Object.assign(user, userUpdate);
        await user.save({ session });
      }
    }

    if (trainerId !== undefined) {
      member.trainer = await resolveValidTrainer(trainerId, member.branchCode, req.gymId);
    }

    Object.assign(member, memberPayload);
    await member.save({ session });

    // Audit Logging
    await AuditLog.create([{
      gymId: req.gymId,
      targetId: member._id,
      targetType: "Member",
      action: memberPayload.status === 'inactive' ? "DEACTIVATE_MEMBER" : "UPDATE_MEMBER",
      performedBy: req.user._id,
      oldValues: { member: oldMemberValues, user: oldUserValues },
      newValues: { member: member.toObject(), status: memberPayload.status },
      reason: reason || (memberPayload.status === 'inactive' ? "Administrative deactivation" : "Profile update")
    }], { session });

    await session.commitTransaction();
    session.endSession();

    if (req.app.locals.io) {
      req.app.locals.io.to(req.gymId).emit("member:updated", {
        memberId: member._id,
        status: member.status,
        action: memberPayload.status === 'inactive' ? "deactivated" : "updated"
      });
    }

    sendResponse(res, { 
      message: memberPayload.status === 'inactive' ? "Member deactivated successfully" : "Member updated", 
      data: await member.populate("user trainer currentPlan") 
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
});

const deleteMember = asyncHandler(async (req, res) => {
  const member = await Member.findOne({ _id: req.params.id, gymId: req.gymId });
  if (!member) throw Object.assign(new Error("Member not found in your gym"), { statusCode: 404 });
  if (!enforceBranchOwnership(member.branchCode, req)) {
    throw Object.assign(new Error("Member not found in your branch"), { statusCode: 404 });
  }
  assertTrainerAssignment(req, member);
  
  const userId = member.user;
  const memberId = member._id;

  // Perform cascade deletion of all related data
  await Promise.all([
    Member.findByIdAndDelete(memberId),
    User.findByIdAndDelete(userId),
    Payment.deleteMany({ member: memberId }),
    Attendance.deleteMany({ member: memberId }),
    Progress.deleteMany({ member: memberId }),
    Notification.deleteMany({ user: userId }),
    WorkoutPlan.deleteMany({ assignedTo: memberId, isTemplate: false }),
    DietPlan.deleteMany({ assignedTo: memberId, isTemplate: false })
  ]);

  sendResponse(res, { message: "Member and all associated data deleted permanently", data: {} });
});

const assignPlan = asyncHandler(async (req, res) => {
  await runMembershipPaymentOp(req, res, "assign", ({ member, plan, requestedStartDate }) => {
    const startDate = requestedStartDate ? new Date(requestedStartDate) : new Date();
    return { startDate, expiryDate: calculateExpiry(startDate, plan.duration) };
  });
});

const renewPlan = asyncHandler(async (req, res) => {
  await runMembershipPaymentOp(req, res, "renew", ({ member, plan, requestedStartDate }) => {
    // Preserve existing renewal semantics: extend from the current expiry when
    // the membership is currently active, otherwise start fresh from today.
    // When the client explicitly supplies membershipStartDate, honor it so a
    // retried request recomputes the SAME termKey and dedupes as a replay
    // instead of extending the membership twice.
    let startDate;
    if (requestedStartDate) {
      startDate = new Date(requestedStartDate);
    } else {
      const isCurrentlyActive = member.status === "active" && member.membershipExpiryDate && new Date() < new Date(member.membershipExpiryDate);
      startDate = isCurrentlyActive ? new Date(member.membershipExpiryDate) : new Date();
    }
    return { startDate, expiryDate: calculateExpiry(startDate, plan.duration) };
  });
});

const upgradePlan = asyncHandler(async (req, res) => {
  await runMembershipPaymentOp(req, res, "upgrade", ({ plan, requestedStartDate }) => {
    // Preserve existing upgrade semantics: the new term ALWAYS restarts today,
    // unless the client explicitly supplies membershipStartDate (so a retried
    // request recomputes the SAME termKey and dedupes instead of creating a
    // second payment for the same logical upgrade).
    const startDate = requestedStartDate ? new Date(requestedStartDate) : new Date();
    return { startDate, expiryDate: calculateExpiry(startDate, plan.duration) };
  });
});

const cancelPlan = asyncHandler(async (req, res) => {
  const member = await Member.findOne({ _id: req.params.id, gymId: req.gymId });
  if (!member) throw Object.assign(new Error("Member not found"), { statusCode: 404 });
  if (!enforceBranchOwnership(member.branchCode, req)) {
    throw Object.assign(new Error("Member not found in your branch"), { statusCode: 404 });
  }
  assertTrainerAssignment(req, member);
  
  member.status = "cancelled";
  member.isActivePlan = false;
  await member.save();
  sendResponse(res, { message: "Subscription cancelled", data: member });
});

const freezePlan = asyncHandler(async (req, res) => {
  const member = await Member.findOne({ _id: req.params.id, gymId: req.gymId });
  if (!member) throw Object.assign(new Error("Member not found in your gym"), { statusCode: 404 });
  if (member.status !== "active") throw Object.assign(new Error("Only active members can freeze plans"), { statusCode: 400 });
  if (!enforceBranchOwnership(member.branchCode, req)) {
    throw Object.assign(new Error("Member not found in your branch"), { statusCode: 404 });
  }
  assertTrainerAssignment(req, member);
  
  const now = new Date();
  const expiry = new Date(member.membershipExpiryDate);
  const diffTime = expiry - now;
  const remainingDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  if (remainingDays <= 0) throw Object.assign(new Error("Cannot freeze an expired plan"), { statusCode: 400 });
  
  member.status = "frozen";
  member.isActivePlan = false;
  member.frozenAt = now;
  member.remainingDays = remainingDays;
  await member.save();
  
  sendResponse(res, { message: "Plan frozen successfully", data: member });
});

const resumePlan = asyncHandler(async (req, res) => {
  const member = await Member.findOne({ _id: req.params.id, gymId: req.gymId });
  if (!member || member.status !== "frozen") throw Object.assign(new Error("Only frozen plans can be resumed"), { statusCode: 400 });
  if (!enforceBranchOwnership(member.branchCode, req)) {
    throw Object.assign(new Error("Member not found in your branch"), { statusCode: 404 });
  }
  assertTrainerAssignment(req, member);
  
  const now = new Date();
  member.status = "active";
  member.isActivePlan = true;
  member.membershipExpiryDate = calculateExpiry(now, member.remainingDays);
  member.frozenAt = null;
  member.remainingDays = null;
  await member.save();
  
  sendResponse(res, { message: "Plan resumed successfully", data: member });
});

const getMyProfile = asyncHandler(async (req, res) => {
  const member = await Member.findOne({ user: req.user._id, gymId: req.gymId })
    .populate("user", SENSITIVE_USER_FIELDS)
    .populate("trainer", SENSITIVE_USER_FIELDS)
    .populate("currentPlan");
  if (!member) throw Object.assign(new Error("Member profile not found"), { statusCode: 404 });
  sendResponse(res, { message: "Profile fetched", data: member });
});

const updateMyProfile = asyncHandler(async (req, res) => {
  const payload = {};
  ["name", "phone", "email"].forEach((k) => {
    if (req.body[k] !== undefined) payload[k] = req.body[k];
  });
  if (req.file) payload.photo = `/uploads/${req.file.filename}`;
  await User.findByIdAndUpdate(req.user._id, payload);
  const member = await Member.findOne({ user: req.user._id, gymId: req.gymId })
    .populate("user", SENSITIVE_USER_FIELDS)
    .populate("trainer", SENSITIVE_USER_FIELDS)
    .populate("currentPlan");
  sendResponse(res, { message: "Profile updated", data: member });
});

const approveMember = asyncHandler(async (req, res) => {
  const member = await Member.findOne({ _id: req.params.id, gymId: req.gymId });
  if (!member) throw Object.assign(new Error("Member not found"), { statusCode: 404 });
  if (!enforceBranchOwnership(member.branchCode, req)) {
    throw Object.assign(new Error("Member not found in your branch"), { statusCode: 404 });
  }
  assertTrainerAssignment(req, member);
  
  member.status = "active";
  await member.save();

  // Also ensure User document is active
  await User.findByIdAndUpdate(member.user, { status: "active" });
  
  sendResponse(res, { message: "Member approved successfully", data: member });
});

// Links (or clears) the eSSL/ZKTeco terminal User ID for a member. The User ID
// is the numeric identifier assigned to the member on the physical device panel,
// which the ADMS protocol uses to resolve punches back to this Member record.
const linkBiometric = asyncHandler(async (req, res) => {
  if (req.body.deviceUserId === undefined) {
    throw Object.assign(new Error("deviceUserId is required"), { statusCode: 400 });
  }
  const deviceUserId = String(req.body.deviceUserId).trim();

  const member = await Member.findOne({ _id: req.params.id, gymId: req.gymId });
  if (!member) throw Object.assign(new Error("Member not found in your gym"), { statusCode: 404 });
  if (!enforceBranchOwnership(member.branchCode, req)) {
    throw Object.assign(new Error("Member not found in your branch"), { statusCode: 404 });
  }
  assertTrainerAssignment(req, member);

  let updated;
  try {
    updated = await Member.findByIdAndUpdate(
      member._id,
      { $set: { "biometrics.deviceUserId": deviceUserId } },
      { new: true }
    )
      .populate("user", SENSITIVE_USER_FIELDS)
      .populate("trainer", SENSITIVE_USER_FIELDS)
      .populate("currentPlan");
  } catch (error) {
    throw error;
  }

  if (req.app.locals.io) {
    req.app.locals.io.to(req.gymId).emit("member:updated", {
      memberId: member._id,
      biometrics: { deviceUserId },
      action: deviceUserId ? "biometric_linked" : "biometric_unlinked"
    });
  }

  sendResponse(res, {
    message: deviceUserId
      ? `Biometric device user ID ${deviceUserId} linked to member`
      : "Biometric device user ID removed",
    data: updated
  });
});

module.exports = { 
  createMember, 
  listMembers, 
  searchMembers, 
  getMember, 
  updateMember, 
  deleteMember, 
  assignPlan, 
  renewPlan,
  upgradePlan,
  cancelPlan,
  freezePlan,
  resumePlan,
  approveMember,
  linkBiometric,
  getMyProfile, 
  updateMyProfile,
  // Exported for unit tests (pure, non-DB helpers).
  memberMatchesTerm,
  classifyDuplicateKey
};
