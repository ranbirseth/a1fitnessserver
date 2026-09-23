const jwt = require("jsonwebtoken");
const User = require("../models/user.model");
const Member = require("../models/member.model");
const { assertMemberEligible, BLOCKED_MEMBER_STATUSES } = require("../utils/membership");

const protect = async (req, _res, next) => {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return next(Object.assign(new Error("Unauthorized"), { statusCode: 401 }));
  try {
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    req.user = await User.findById(decoded.sub).select("-password -refreshTokens");
    if (!req.user) throw new Error("User not found");
    
    // Check if user account is deactivated
    if (req.user.status === "inactive") {
      return next(Object.assign(new Error("Your account has been deactivated. Please contact admin."), { statusCode: 403 }));
    }

    req.gymId = req.user.gymId;
    
    // If user is a member, check their status/payment
    if (req.user.role === "member") {
      const member = await Member.findOne({ user: req.user._id, gymId: req.gymId });
      if (member) {
        req.member = member;
        // Block access for inactive, pending, or cancelled members
        if (BLOCKED_MEMBER_STATUSES.includes(member.status)) {
          return next(Object.assign(new Error(`Account ${member.status}. Please contact admin.`), { statusCode: 403 }));
        }
      }
    }
    
    next();
  } catch {
    next(Object.assign(new Error("Invalid token"), { statusCode: 401 }));
  }
};

const authorize = (...requiredPermissions) => (req, _res, next) => {
  if (!req.user) {
    return next(Object.assign(new Error("Unauthorized"), { statusCode: 401 }));
  }

  // Superadmin bypass
  if (req.user.role === "superadmin") return next();

  // Role to permissions mapping
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
    ],
    member: ["view_own_data"]
  };

  const userPermissions = rolePermissions[req.user.role] || [];
  
  // Check if user has all required permissions or if the role is explicitly allowed (for backward compatibility)
  const hasPermissions = requiredPermissions.every(p => userPermissions.includes(p));
  const hasRole = requiredPermissions.includes(req.user.role);

  if (!hasPermissions && !hasRole) {
    return next(Object.assign(new Error("Forbidden: Insufficient permissions"), { statusCode: 403 }));
  }
  next();
};

const adminOnly = (req, _res, next) => {
  if (!req.user) {
    return next(Object.assign(new Error("Unauthorized"), { statusCode: 401 }));
  }
  if (req.user.role !== "admin") {
    return next(Object.assign(new Error("Forbidden: Only branch admins can manage scanners"), { statusCode: 403 }));
  }
  next();
};

const checkPlanAccess = async (req, _res, next) => {
  if (req.user.role === "member") {
    const member = req.member || (await Member.findOne({ user: req.user._id, gymId: req.gymId }));
    if (!member) return next(Object.assign(new Error("Member profile not found"), { statusCode: 404 }));
    try {
      assertMemberEligible(member);
    } catch (err) {
      return next(err);
    }
  }
  next();
};

const protectOptional = async (req, _res, next) => {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return next();
  try {
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    req.user = await User.findById(decoded.sub).select("-password -refreshTokens");
    if (req.user) {
      req.gymId = req.user.gymId;
    }
    next();
  } catch {
    next();
  }
};

module.exports = { protect, protectOptional, authorize, adminOnly, checkPlanAccess };
