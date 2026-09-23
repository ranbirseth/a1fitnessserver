const Payment = require("../models/payment.model");
const Notification = require("../models/notification.model");
const Member = require("../models/member.model");
const User = require("../models/user.model");
const { asyncHandler } = require("../utils/asyncHandler");
const { sendResponse } = require("../utils/response");
const { getPagination } = require("../utils/pagination");
const invoiceDeliveryService = require("../services/invoiceDelivery.service");
const { resolveBusinessStatusMemberIds } = require("../services/paymentStatusFilter.service");
const mongoose = require("mongoose");
const PDFDocument = require("pdfkit");

const GYM_BRAND = {
  name: "A1 FITNESS",
  displayName: "A1 FITNESS",
  tagline: "Premium Fitness Center",
  logo: "/logo.svg",
  address: "",
  phone: "+91 98765 43210",
  email: "contact@a1fitness.com",
  website: "www.a1fitness.com",
  gst: null,
  currency: "INR",
  currencySymbol: "\u20B9"
};

const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildSearchFilter = (gymId, query) => {
  const filter = { gymId };
  if (query.status && query.status !== "all") filter.status = query.status;
  if (query.method && query.method !== "all") filter.method = query.method;

  if (query.dateFrom || query.dateTo) {
    filter.date = {};
    if (query.dateFrom) {
      const from = new Date(query.dateFrom);
      from.setHours(0, 0, 0, 0);
      filter.date.$gte = from;
    }
    if (query.dateTo) {
      const to = new Date(query.dateTo);
      to.setHours(23, 59, 59, 999);
      filter.date.$lte = to;
    }
  }

  return filter;
};

// Resolves a free-text search term to member ids matching user name/email/phone or secretCode,
// so the search can run fully in the database (correct counts across pages).
const resolveSearchMemberIds = async (gymId, q) => {
  const rx = { $regex: escapeRegex(q), $options: "i" };
  const users = await User.find({
    gymId,
    $or: [{ name: rx }, { email: rx }, { phone: rx }]
  }).select("_id");
  const members = await Member.find({
    gymId,
    $or: [{ user: { $in: users.map((u) => u._id) } }, { secretCode: rx }]
  }).select("_id");
  return members.map((m) => m._id);
};

const resolveRequestedBranch = (req) =>
  req.user.role === "superadmin"
    ? (req.query.branchCode && req.query.branchCode !== "ALL" && req.query.branchCode !== "all" ? req.query.branchCode.trim().toUpperCase() : undefined)
    : (req.user.branchCode || "MAIN").trim().toUpperCase();

const createPayment = asyncHandler(async (req, res) => {
  const { member: memberId, plan: planId, amount, method = "cash", status = "paid", note, date } = req.body;
  if (!memberId || !planId || !amount) {
    throw Object.assign(new Error("Member, Plan and Amount are required"), { statusCode: 400 });
  }

  const gymId = req.gymId;
  const scopedBranch = req.user.role === "superadmin" ? undefined : (req.user.branchCode || "MAIN");
  const memberQuery = { _id: memberId, gymId, ...(scopedBranch ? { branchCode: scopedBranch } : {}) };
  const scopedMember = await Member.findOne(memberQuery);
  if (!scopedMember) throw Object.assign(new Error("Member not found in your branch"), { statusCode: 404 });
  // Trainer isolation: trainers may only create payments for their assigned members.
  if (req.user.role === "trainer") {
    if (!scopedMember.trainer || String(scopedMember.trainer) !== String(req.user._id)) {
      throw Object.assign(new Error("You can only create payments for members assigned to you"), { statusCode: 403 });
    }
  }

  // Idempotency / backward compatibility: assign/renew/upgrade now create the
  // Payment atomically inside their own transaction. The legacy web flow still
  // issues a separate POST /api/payments immediately afterwards. If a Payment
  // already exists whose term snapshots exactly match the member's CURRENT term,
  // treat this second call as an idempotent completion (apply the fields that
  // were sent, e.g. an edited amount/method/status) and return it instead of
  // duplicating revenue. Payments for other/historical terms are untouched.
  if (scopedMember.membershipStartDate && scopedMember.membershipExpiryDate) {
    const existingTermPayment = await Payment.findOne({
      gymId,
      member: scopedMember._id,
      plan: planId,
      membershipStartDate: scopedMember.membershipStartDate,
      membershipExpiryDate: scopedMember.membershipExpiryDate
    });
    if (existingTermPayment) {
      const patch = {};
      if (amount !== undefined) patch.amount = amount;
      if (method !== undefined) patch.method = method;
      if (status !== undefined) patch.status = status;
      if (note !== undefined) patch.note = note;
      if (date !== undefined) patch.date = date;
      if (Object.keys(patch).length > 0) {
        Object.assign(existingTermPayment, patch);
        await existingTermPayment.save();
      }

      const effectiveStatus = status !== undefined ? status : existingTermPayment.status;
      if (effectiveStatus === "paid") {
        scopedMember.paymentStatus = "paid";
        if (scopedMember.membershipExpiryDate && new Date() < new Date(scopedMember.membershipExpiryDate)) {
          scopedMember.status = "active";
          scopedMember.isActivePlan = true;
        }
      } else {
        scopedMember.paymentStatus = "pending";
        scopedMember.status = "pending";
        scopedMember.isActivePlan = false;
      }
      await scopedMember.save();

      sendResponse(res, {
        message: "Payment for the current membership term already recorded. Updated instead of duplicating.",
        data: existingTermPayment
      });
      return;
    }
  }

  const invoiceNumber = `INV-${Date.now()}`;
  const branchCode = scopedMember.branchCode || "MAIN";

  const payment = await Payment.create({
    gymId,
    member: memberId,
    plan: planId,
    amount,
    method,
    status,
    note,
    date: date || new Date(),
    invoiceNumber,
    branchCode,
    membershipExpiryDate: scopedMember.membershipExpiryDate || undefined,
    membershipStartDate: scopedMember.membershipStartDate || undefined,
    invoice: {
      invoiceNumber,
      amount,
      member: memberId,
      plan: planId,
      branchCode,
      createdAt: new Date().toISOString()
    }
  });

  const member = scopedMember;
  if (member) {
    if (status === "paid") {
      member.paymentStatus = "paid";
      if (member.membershipExpiryDate && new Date() < new Date(member.membershipExpiryDate)) {
        member.status = "active";
        member.isActivePlan = true;
      }
      await member.save();
    }

    await Notification.create({
      user: member.user,
      title: status === "pending" ? "Payment pending" : "Payment received",
      message: `Invoice ${invoiceNumber} for amount ${amount} (${status})`,
      type: "payment"
    });
  }

  sendResponse(res, { status: 201, message: "Payment recorded", data: payment });
});

const listPayments = asyncHandler(async (req, res) => {
  const { skip, limit, page } = getPagination(req.query);
  const gymId = req.gymId;
  const q = (req.query.q || req.query.search || "").trim();

  const filter = buildSearchFilter(gymId, req.query);
  const requestedBranch = resolveRequestedBranch(req);
  const businessStatus = (req.query.businessStatus || "all").toString().toLowerCase();

  // Search, branch restrictions and the business-status bucket are combined via
  // $and so none clobbers the other.
  const conditions = [];
  if (q) {
    const matchedMemberIds = await resolveSearchMemberIds(gymId, q);
    conditions.push({
      $or: [
        { invoiceNumber: { $regex: escapeRegex(q), $options: "i" } },
        { member: { $in: matchedMemberIds } }
      ]
    });
  }
  if (requestedBranch) {
    const memberQuery = { gymId, branchCode: requestedBranch };
    // Trainer isolation: trainers only see payments for their assigned members.
    if (req.user && req.user.role === "trainer") {
      memberQuery.trainer = req.user._id;
    }
    const memberIds = await Member.find(memberQuery).distinct("_id");
    // Payments follow their member's CURRENT branch. Scoping by the payment's
    // stored branchCode instead would let a member reassigned to another branch
    // leak their historical payments into the old branch's list.
    conditions.push({ member: { $in: memberIds } });
  }
  if (businessStatus && businessStatus !== "all") {
    const bucketMemberIds = await resolveBusinessStatusMemberIds({
      gymId,
      branchCode: requestedBranch,
      code: businessStatus,
      now: new Date()
    });
    conditions.push({ member: { $in: bucketMemberIds } });
  }
  if (conditions.length > 0) filter.$and = conditions;

  const [items, total] = await Promise.all([
    Payment.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate({
        path: "member",
        populate: { path: "user", select: "name email phone address" }
      })
      .populate("plan", "name duration price"),
    Payment.countDocuments(filter)
  ]);

  sendResponse(res, { message: "Payments fetched", data: { items, page, limit, total } });
});

const getMyPayments = asyncHandler(async (req, res) => {
  const { skip, limit, page } = getPagination(req.query);

  const member = await Member.findOne({ user: req.user._id, gymId: req.gymId });
  if (!member) throw Object.assign(new Error("Member profile not found"), { statusCode: 404 });

  const filter = { gymId: req.gymId, member: member._id };
  if (req.query.status && req.query.status !== "all") filter.status = req.query.status;

  const [items, total] = await Promise.all([
    Payment.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate({
        path: "member",
        populate: { path: "user", select: "name email phone address" }
      })
      .populate("plan", "name duration price"),
    Payment.countDocuments(filter)
  ]);
  sendResponse(res, { message: "Payments fetched", data: { items, page, limit, total } });
});

const pendingDues = asyncHandler(async (req, res) => {
  const { skip, limit, page } = getPagination(req.query);
  const filter = { gymId: req.gymId, status: "pending" };

  // Branch isolation: non-superadmins only see dues for their own branch;
  // superadmin may filter via ?branchCode=CODE or see all with ALL.
  const requestedBranch = resolveRequestedBranch(req);
  if (requestedBranch) {
    const memberQuery = { gymId: req.gymId, branchCode: requestedBranch };
    // Trainer isolation: trainers only see pending dues for their assigned members.
    if (req.user && req.user.role === "trainer") {
      memberQuery.trainer = req.user._id;
    }
    const memberIds = await Member.find(memberQuery).distinct("_id");
    // Scope pending dues by the member's CURRENT branch so a reassigned member's
    // stale payment no longer leaks into the old branch.
    filter.member = { $in: memberIds };
  }

  const [items, total] = await Promise.all([
    Payment.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate({ path: "member", populate: { path: "user", select: "name" } })
      .populate("plan", "name"),
    Payment.countDocuments(filter)
  ]);
  sendResponse(res, { message: "Pending dues fetched", data: { items, page, limit, total } });
});

const buildDetailedInvoice = (payment) => {
  const user = payment.member?.user || {};
  const plan = payment.plan || {};
  const member = payment.member || {};

  const billingStart = member.membershipStartDate || payment.date;
  const billingEnd = member.membershipExpiryDate
    ? member.membershipExpiryDate
    : plan.duration
      ? (() => {
          const d = new Date(payment.date);
          d.setDate(d.getDate() + (plan.duration || 30));
          return d;
        })()
      : null;

  const subtotal = Number(payment.amount || 0);
  const discount = Number(payment.invoice?.discount || 0);
  const tax = Number(payment.invoice?.tax || 0);
  const quantity = Number(payment.invoice?.quantity || 1);
  const unitPrice = Number(payment.invoice?.unitPrice || subtotal);

  const lineItems = [
    {
      description: plan.name || "Membership Plan",
      details: plan.duration ? `${plan.duration} Days Access` : "",
      quantity,
      unitPrice,
      amount: subtotal
    }
  ];

  if (payment.invoice?.additionalLineItems && Array.isArray(payment.invoice.additionalLineItems)) {
    lineItems.push(...payment.invoice.additionalLineItems);
  }

  const total = subtotal - discount + tax;

  return {
    _id: payment._id,
    invoiceNumber: payment.invoiceNumber,
    date: payment.date,
    dueDate: payment.dueDate || null,
    paymentDate: payment.status === "paid" ? payment.date : null,
    status: payment.status,
    method: payment.method,
    referenceId: payment.invoice?.intentId || payment.invoice?.referenceId || payment._id,
    note: payment.note || "",
    quantity,
    unitPrice,
    discount,
    tax,
    subtotal,
    total,
    lineItems,
    billingPeriod: {
      start: billingStart,
      end: billingEnd
    },
    business: {
      ...GYM_BRAND
    },
    member: {
      _id: member._id,
      memberId: member.secretCode || null,
      branchCode: member.branchCode || "MAIN",
      name: user.name || "",
      email: user.email || "",
      phone: user.phone || "",
      address: user.address || ""
    },
    plan: {
      _id: plan._id,
      name: plan.name || "",
      duration: plan.duration || null,
      price: plan.price || subtotal
    }
  };
};

const getInvoice = asyncHandler(async (req, res) => {
  const payment = await Payment.findOne({ _id: req.params.id, gymId: req.gymId })
    .populate({
      path: "member",
      populate: { path: "user", select: "name email phone address" }
    })
    .populate("plan", "name description duration price");

  if (!payment) throw Object.assign(new Error("Payment not found in your gym"), { statusCode: 404 });

  if (req.user.role === "member") {
    const member = await Member.findOne({ user: req.user._id, gymId: req.gymId });
    if (!member || String(member._id) !== String(payment.member?._id)) {
      throw Object.assign(new Error("You cannot access this invoice"), { statusCode: 403 });
    }
  } else if (req.user.role !== "superadmin") {
    const userBranch = (req.user.branchCode || "MAIN").trim().toUpperCase();
    const payBranch = (payment.branchCode || payment.member?.branchCode || "MAIN").trim().toUpperCase();
    if (userBranch !== payBranch) {
      throw Object.assign(new Error("Invoice not found in your branch"), { statusCode: 404 });
    }
    // Trainer isolation: trainers may only access invoices for their assigned members.
    if (req.user.role === "trainer") {
      if (!payment.member?.trainer || String(payment.member.trainer) !== String(req.user._id)) {
        throw Object.assign(new Error("You can only access invoices for members assigned to you"), { statusCode: 403 });
      }
    }
  }

  const invoiceData = buildDetailedInvoice(payment);
  sendResponse(res, { message: "Invoice fetched", data: invoiceData });
});

const generateInvoicePDF = asyncHandler(async (req, res) => {
  const payment = await Payment.findOne({ _id: req.params.id, gymId: req.gymId })
    .populate({
      path: "member",
      populate: { path: "user", select: "name email phone address" }
    })
    .populate("plan", "name description duration price");

  if (!payment) throw Object.assign(new Error("Payment not found in your gym"), { statusCode: 404 });

  if (req.user.role === "member") {
    const member = await Member.findOne({ user: req.user._id, gymId: req.gymId });
    if (!member || String(member._id) !== String(payment.member?._id)) {
      throw Object.assign(new Error("You cannot access this invoice"), { statusCode: 403 });
    }
  } else if (req.user.role !== "superadmin") {
    const userBranch = (req.user.branchCode || "MAIN").trim().toUpperCase();
    const payBranch = (payment.branchCode || payment.member?.branchCode || "MAIN").trim().toUpperCase();
    if (userBranch !== payBranch) {
      throw Object.assign(new Error("Invoice not found in your branch"), { statusCode: 404 });
    }
    // Trainer isolation: trainers may only download invoices for their assigned members.
    if (req.user.role === "trainer") {
      if (!payment.member?.trainer || String(payment.member.trainer) !== String(req.user._id)) {
        throw Object.assign(new Error("You can only access invoices for members assigned to you"), { statusCode: 403 });
      }
    }
  }

  const inv = buildDetailedInvoice(payment);
  const doc = new PDFDocument({ size: "A4", margin: 40, info: { Title: `Invoice ${inv.invoiceNumber}`, Author: GYM_BRAND.name, Subject: "Invoice" } });
  const SYM = GYM_BRAND.currencySymbol;
  const filename = `Invoice-${inv.invoiceNumber}.pdf`;

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  doc.pipe(res);

  const pageWidth = doc.page.width - 80;
  const primary = "#6d28d9";
  const accent = "#06b6d4";
  const dark = "#111827";
  const muted = "#6b7280";
  const lightBg = "#f9fafb";

  try {
    const headerY = 40;
    if (GYM_BRAND.logo) {
      try { doc.image(GYM_BRAND.logo, 40, headerY, { width: 50, height: 50, fit: [50, 50] }); }
      catch { doc.rect(40, headerY, 50, 50).fill(primary); }
    } else {
      doc.rect(40, headerY, 50, 50).fill(primary);
    }

    doc.font("Helvetica-Bold").fillColor(primary).fontSize(22).text(GYM_BRAND.displayName, 100, headerY + 6, { width: 300 });
    doc.font("Helvetica").fillColor(muted).fontSize(10).text(GYM_BRAND.tagline, 100, headerY + 32, { width: 300 });

    doc.font("Helvetica-Bold").fillColor(dark).fontSize(24).text("INVOICE", 40, headerY, { align: "right" });
    doc.font("Helvetica").fillColor(muted).fontSize(10).moveUp(0.3).text(`#${inv.invoiceNumber}`, 40, doc.y, { align: "right" });

    const topBarY = headerY + 70;
    doc.moveTo(40, topBarY).lineTo(pageWidth + 40, topBarY).stroke(primary).lineWidth(1.5);

    const infoY = topBarY + 20;
    const leftColX = 40;
    const rightColX = pageWidth + 40 - 240;

    doc.font("Helvetica-Bold").fillColor(dark).fontSize(11).text("BILLED TO", leftColX, infoY);
    doc.font("Helvetica").fillColor(dark).fontSize(11).text(inv.member.name, leftColX, doc.y + 6);
    if (inv.member.memberId) doc.fillColor(muted).fontSize(10).text(`Member ID: ${inv.member.memberId}`, leftColX, doc.y + 2);
    if (inv.member.email) doc.fillColor(dark).fontSize(10).text(inv.member.email, leftColX, doc.y + 3);
    if (inv.member.phone) doc.fillColor(dark).fontSize(10).text(inv.member.phone, leftColX, doc.y + 2);
    if (inv.member.address) {
      doc.fillColor(muted).fontSize(10);
      const addr = inv.member.address.length > 120 ? inv.member.address.slice(0, 120) + "..." : inv.member.address;
      doc.text(addr, leftColX, doc.y + 3, { width: 260 });
    }

    doc.font("Helvetica-Bold").fillColor(dark).fontSize(11).text("INVOICE DETAILS", rightColX, infoY);
    const rows = [
      ["Invoice Date", inv.date ? new Date(inv.date).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "-"],
      ["Due Date", inv.dueDate ? new Date(inv.dueDate).toLocaleDateString() : "-"],
      ["Status", (inv.status || "").toUpperCase()],
      ["Method", (inv.method || "cash").toUpperCase()]
    ];
    let ry = doc.y + 6;
    rows.forEach(([k, v]) => {
      doc.fillColor(muted).font("Helvetica").fontSize(10).text(k, rightColX, ry, { width: 100 });
      doc.fillColor(dark).font("Helvetica-Bold").fontSize(10).text(v, rightColX + 100, ry, { width: 140, align: "right" });
      ry += 16;
    });

    const tableTop = Math.max(ry + 10, infoY + 140);
    doc.fillColor(lightBg).rect(40, tableTop, pageWidth, 28).fill();
    doc.fillColor(dark).font("Helvetica-Bold").fontSize(10);
    const cols = [
      { label: "DESCRIPTION", x: 50, w: 230 },
      { label: "QTY", x: 290, w: 50, align: "center" },
      { label: "UNIT", x: 350, w: 70, align: "right" },
      { label: "AMOUNT", x: pageWidth + 40 - 90, w: 80, align: "right" }
    ];
    cols.forEach((c) => doc.text(c.label, c.x, tableTop + 9, { width: c.w, align: c.align || "left" }));

    let lineY = tableTop + 30;
    inv.lineItems.forEach((item) => {
      if (lineY > 720) { doc.addPage(); lineY = 60; }
      doc.fillColor(dark).font("Helvetica-Bold").fontSize(10).text(item.description, cols[0].x, lineY, { width: cols[0].w });
      if (item.details) {
        doc.fillColor(muted).font("Helvetica").fontSize(9).text(item.details, cols[0].x, doc.y + 2, { width: cols[0].w });
      }
      const baseY = lineY;
      doc.fillColor(dark).font("Helvetica").fontSize(10)
        .text(String(item.quantity || 1), cols[1].x, baseY, { width: cols[1].w, align: "center" })
        .text(`${SYM}${Number(item.unitPrice || 0).toLocaleString("en-IN")}`, cols[2].x, baseY, { width: cols[2].w, align: "right" })
        .text(`${SYM}${Number(item.amount || 0).toLocaleString("en-IN")}`, cols[3].x, baseY, { width: cols[3].w, align: "right" });
      lineY += 28;
      doc.moveTo(40, lineY).lineTo(pageWidth + 40, lineY).dash(2, { space: 2 }).strokeColor("#e5e7eb").stroke().undash().strokeColor(dark);
      lineY += 4;
    });

    const totalsStartY = lineY + 10;
    const totalsColX = pageWidth + 40 - 200;
    const rowsTotal = [
      ["Subtotal", inv.subtotal, false],
      ["Discount", -inv.discount, inv.discount > 0],
      ["Tax", inv.tax, inv.tax > 0],
      ["Total", inv.total, true]
    ];
    let ty = totalsStartY;
    rowsTotal.forEach(([label, val, bold]) => {
      if (val === 0 && label !== "Subtotal" && label !== "Total") return;
      doc.fillColor(muted).fontSize(10).font("Helvetica").text(label, totalsColX, ty, { width: 100 });
      doc.fillColor(dark).fontSize(11).font(bold ? "Helvetica-Bold" : "Helvetica")
        .text(`${val < 0 ? "-" : ""}${SYM}${Math.abs(Number(val || 0)).toLocaleString("en-IN")}`, totalsColX + 100, ty, { width: 100, align: "right" });
      ty += 18;
    });

    if (inv.referenceId) {
      ty += 4;
      doc.fillColor(muted).fontSize(9).font("Helvetica").text(`Transaction / Reference ID: ${inv.referenceId}`, 40, ty);
      ty += 14;
    }
    if (inv.billingPeriod?.start && inv.billingPeriod?.end) {
      const s = new Date(inv.billingPeriod.start).toLocaleDateString("en-IN");
      const e = new Date(inv.billingPeriod.end).toLocaleDateString("en-IN");
      doc.fillColor(muted).fontSize(9).font("Helvetica").text(`Billing Period: ${s} - ${e}`, 40, ty);
      ty += 14;
    }
    if (inv.note) {
      doc.fillColor(muted).fontSize(9).font("Helvetica").text(`Note: ${inv.note}`, 40, ty, { width: pageWidth });
      ty += 14;
    }

    const footerY = Math.max(ty + 30, 780);
    doc.moveTo(40, footerY).lineTo(pageWidth + 40, footerY).strokeColor("#e5e7eb").dash(1, { space: 2 }).stroke().undash().strokeColor(dark);
    doc.fillColor(muted).fontSize(9).font("Helvetica").text("Thank you for your business!", 40, footerY + 12, { align: "center", width: pageWidth });
    doc.fillColor(accent).fontSize(9).font("Helvetica").text(
      `${GYM_BRAND.website}  |  ${GYM_BRAND.email}  |  ${GYM_BRAND.phone}`,
      40, footerY + 26, { align: "center", width: pageWidth }
    );
    doc.fillColor(muted).fontSize(8).font("Helvetica").text(
      "This is a computer-generated invoice. No physical signature required.",
      40, footerY + 42, { align: "center", width: pageWidth }
    );

    doc.end();
  } catch (err) {
    if (!res.headersSent) {
      res.setHeader("Content-Type", "application/json");
    }
    doc.end();
    throw err;
  }
});

const getInvoiceDeliveryStatus = asyncHandler(async (req, res) => {
  const status = await invoiceDeliveryService.canSendInvoice(req.gymId);
  sendResponse(res, { message: "Delivery status", data: status });
});

const sendInvoice = asyncHandler(async (req, res) => {
  const payment = await Payment.findOne({ _id: req.params.id, gymId: req.gymId })
    .populate("member", "trainer branchCode");
  if (!payment) throw Object.assign(new Error("Payment not found"), { statusCode: 404 });

  if (req.user && req.user.role !== "superadmin") {
    const userBranch = (req.user.branchCode || "MAIN").trim().toUpperCase();
    const payBranch = (payment.branchCode || payment.member?.branchCode || "MAIN").trim().toUpperCase();
    if (userBranch !== payBranch) {
      throw Object.assign(new Error("Invoice not found in your branch"), { statusCode: 404 });
    }
    // Trainer isolation: trainers may only send invoices for their assigned members.
    if (req.user.role === "trainer") {
      if (!payment.member?.trainer || String(payment.member.trainer) !== String(req.user._id)) {
        throw Object.assign(new Error("You can only access invoices for members assigned to you"), { statusCode: 403 });
      }
    }
  }

  const status = await invoiceDeliveryService.canSendInvoice(req.gymId);
  if (!status.allowed) {
    throw Object.assign(new Error(status.message || "Subscription required"), {
      statusCode: 402,
      data: status
    });
  }
  const result = await invoiceDeliveryService.sendInvoice(payment, req.body.channels);
  sendResponse(res, { message: "Invoice sent request processed", data: result });
});

// No external payment gateway is configured. These endpoints are intentionally
// disabled: no mock intent, no fake transaction id, no payment record, and no
// membership activation can result from them.
const createOnlinePaymentIntent = asyncHandler(async (_req, _res) => {
  throw Object.assign(
    new Error("Online payment gateway is not configured. Please collect payment manually (cash/card/UPI)."),
    { statusCode: 501 }
  );
});

const confirmOnlinePayment = asyncHandler(async (_req, _res) => {
  throw Object.assign(
    new Error("Online payment gateway is not configured. Online payments cannot be confirmed."),
    { statusCode: 501 }
  );
});

const markAsPaid = asyncHandler(async (req, res) => {
  const payment = await Payment.findOne({ _id: req.params.id, gymId: req.gymId }).populate("member", "branchCode trainer");
  if (!payment) throw Object.assign(new Error("Payment not found"), { statusCode: 404 });

  if (req.user.role !== "superadmin") {
    const userBranch = (req.user.branchCode || "MAIN").trim().toUpperCase();
    const payBranch = (payment.branchCode || payment.member?.branchCode || "MAIN").trim().toUpperCase();
    if (userBranch !== payBranch) {
      throw Object.assign(new Error("Payment not found in your branch"), { statusCode: 404 });
    }
    // Trainer isolation: trainers may only mark payments for their assigned members.
    if (req.user.role === "trainer") {
      if (!payment.member?.trainer || String(payment.member.trainer) !== String(req.user._id)) {
        throw Object.assign(new Error("You can only modify payments for members assigned to you"), { statusCode: 403 });
      }
    }
  }

  payment.status = "paid";
  await payment.save();

  const member = await Member.findOne({ _id: payment.member, gymId: req.gymId });
  if (member) {
    member.paymentStatus = "paid";
    if (member.membershipExpiryDate && new Date() < new Date(member.membershipExpiryDate)) {
      member.status = "active";
      member.isActivePlan = true;
    }
    await member.save();
  }

  sendResponse(res, { message: "Payment marked as paid", data: payment });
});

const markAsUnpaid = asyncHandler(async (req, res) => {
  const payment = await Payment.findOne({ _id: req.params.id, gymId: req.gymId }).populate("member", "branchCode trainer");
  if (!payment) throw Object.assign(new Error("Payment not found"), { statusCode: 404 });

  if (req.user.role !== "superadmin") {
    const userBranch = (req.user.branchCode || "MAIN").trim().toUpperCase();
    const payBranch = (payment.branchCode || payment.member?.branchCode || "MAIN").trim().toUpperCase();
    if (userBranch !== payBranch) {
      throw Object.assign(new Error("Payment not found in your branch"), { statusCode: 404 });
    }
    // Trainer isolation: trainers may only modify payments for their assigned members.
    if (req.user.role === "trainer") {
      if (!payment.member?.trainer || String(payment.member.trainer) !== String(req.user._id)) {
        throw Object.assign(new Error("You can only modify payments for members assigned to you"), { statusCode: 403 });
      }
    }
  }

  payment.status = "pending";
  await payment.save();

  const member = await Member.findOne({ _id: payment.member, gymId: req.gymId });
  if (member) {
    member.paymentStatus = "pending";
    member.status = "pending";
    member.isActivePlan = false;
    await member.save();
  }

  sendResponse(res, { message: "Payment marked as unpaid", data: payment });
});

module.exports = {
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
};
