const cron = require("node-cron");
const Member = require("../models/member.model");
const Notification = require("../models/notification.model");
const { sendRenewalReminders } = require("../services/reminder.service");

const startExpiryReminderJob = () => {
  // Run every hour to check for expirations
  cron.schedule("0 * * * *", async () => {
    const now = new Date();

    // 1. Mark expired memberships
    const expiredMembers = await Member.updateMany(
      {
        membershipExpiryDate: { $lt: now },
        status: "active"
      },
      {
        status: "expired",
        isActivePlan: false
      }
    );
    if (expiredMembers.modifiedCount > 0) {
      console.log(`Marked ${expiredMembers.modifiedCount} memberships as expired.`);
    }

    // 2 & 3. Send expiry + payment reminders (at 9 AM daily).
    if (now.getHours() === 9) {
      console.log("[WHATSAPP] --> scheduled expiry reminder cron fired (9 AM pass)");
      // Expiry reminders via the shared calendar-day reminder service
      // (in-app expiry notifications with deduplication).
      const summary = await sendRenewalReminders({ gymId: undefined, branchCode: undefined, now });
      if (summary.inAppSent > 0) {
        console.log(`Sent ${summary.inAppSent} expiry reminder(s); ${summary.duplicatesSkipped} duplicate(s) skipped.`);
      }

      // Payment reminders for pending payments
      const pendingPaymentMembers = await Member.find({
        paymentStatus: "pending",
        status: { $in: ["active", "pending"] }
      });

      if (pendingPaymentMembers.length) {
        await Notification.insertMany(
          pendingPaymentMembers.map((m) => ({
            user: m.user,
            title: "Payment Pending",
            message: "You have a pending payment for your membership. Please pay to avoid access issues.",
            type: "payment"
          }))
        );
      }
    }
  });
};

module.exports = { startExpiryReminderJob };
