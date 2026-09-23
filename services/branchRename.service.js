const mongoose = require("mongoose");
const { Branch, Referral } = require("../models/generic.model");
const User = require("../models/user.model");
const Member = require("../models/member.model");
const Payment = require("../models/payment.model");
const Attendance = require("../models/attendance.model");
const WorkoutPlan = require("../models/workout.model");
const DietPlan = require("../models/diet.model");
const Plan = require("../models/plan.model");
const PlanBranch = require("../models/planBranch.model");

const BRANCH_CODE_RE = /^[A-Z0-9][A-Z0-9_-]{1,19}$/;

const normalizeBranchCode = (code) => (typeof code === "string" ? code.trim().toUpperCase() : "");

/**
 * Only Super Admin may call this. Renames a branch's branchCode (OLD -> NEW)
 * and atomically cascades the new code to every collection that denormalizes it
 * so no dependent record is orphaned (members, staff users, payments,
 * attendance, workouts, diets, plans, plan-branch assignments, referrals).
 *
 * Historical AuditLog oldValues/newValues snapshots are intentionally left
 * untouched. Plan.branchCode is only updated on EXACT oldCode matches;
 * null / "ALL" (global) plans are never modified.
 *
 * Runs inside a MongoDB session transaction. If ANY update fails the whole
 * migration is aborted and rolled back - no partial branch-code change persists.
 */
const renameBranchCode = async ({ gymId, branchId, oldCode, newCode, branchPatch = {} }) => {
  const next = normalizeBranchCode(newCode);
  const old = normalizeBranchCode(oldCode);

  if (!branchId) throw Object.assign(new Error("Branch not found"), { statusCode: 404 });
  if (!next) throw Object.assign(new Error("Branch code is required"), { statusCode: 400 });
  if (!BRANCH_CODE_RE.test(next)) {
    throw Object.assign(new Error("Branch code must be 2-20 characters and contain only letters, numbers, hyphens, or underscores."), { statusCode: 400 });
  }

  const branch = await Branch.findOne({ _id: branchId, gymId });
  if (!branch) throw Object.assign(new Error("Branch not found"), { statusCode: 404 });

  // No-op when the code is unchanged - nothing to migrate.
  if (old === next) return { branch, migrated: false, updatedCounts: {} };

  const duplicate = await Branch.exists({ gymId, branchCode: next, _id: { $ne: branchId } });
  if (duplicate) {
    throw Object.assign(new Error(`Branch code ${next} already exists.`), { statusCode: 409 });
  }

  const { branchCode: _, ...patch } = branchPatch;

  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const dependents = [
      { name: "User", model: User },
      { name: "Member", model: Member },
      { name: "Payment", model: Payment },
      { name: "Attendance", model: Attendance },
      { name: "WorkoutPlan", model: WorkoutPlan },
      { name: "DietPlan", model: DietPlan },
      { name: "Plan", model: Plan },
      { name: "PlanBranch", model: PlanBranch }
    ];

    const updatedCounts = {};
    for (const { name, model } of dependents) {
      const res = await model.updateMany(
        { gymId, branchCode: old },
        { $set: { branchCode: next } },
        { session }
      );
      updatedCounts[name] = res.modifiedCount;
    }

    const referralRes = await Referral.updateMany(
      { gymId, "metadata.branchCode": old },
      { $set: { "metadata.branchCode": next } },
      { session }
    );
    updatedCounts.Referral = referralRes.modifiedCount;

    // Branch is updated LAST, inside the same transaction.
    const updated = await Branch.findOneAndUpdate(
      { _id: branchId, gymId },
      { $set: { ...patch, branchCode: next } },
      { new: true, runValidators: true, session }
    );

    await session.commitTransaction();
    return { branch: updated, migrated: true, updatedCounts };
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

module.exports = { renameBranchCode, normalizeBranchCode, BRANCH_CODE_RE };