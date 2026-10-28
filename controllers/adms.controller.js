const { parseAttLog } = require("../utils/admsParser");
const Member = require("../models/member.model");

async function handleRegistry(req, res, url) {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("OK\nRegistryCode=Valid\n");
}

async function handleGetRequest(req, res, url) {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("OK\n");
}

async function handleCdata(req, res, url, body) {
  const table = (url.searchParams.get("table") || "").toUpperCase();
  const stamp = url.searchParams.get("Stamp") || url.searchParams.get("OpStamp") || "9999";
  const io = req.app.locals.io;

  // 1. Process door logic if it is an attendance punch
  if (table === "ATTLOG" && body && body.trim()) {
    try {
      const records = parseAttLog(body, "UTC");
      for (const record of records) {
        const recordId = String(record.userId || "").trim();
        if (!recordId) continue;

        const numericId = parseInt(recordId, 10);
        const member = await Member.findOne({
          $or: [
            { "biometrics.deviceUserId": recordId },
            { "biometrics.deviceUserId": numericId },
            { memberId: recordId },
            { memberId: numericId }
          ]
        }).populate("user", "name");

        const membershipIsValid = member &&
          member.status === "active" &&
          new Date(member.membershipExpiryDate) > new Date();

        if (membershipIsValid) {
          const name = (member.user && member.user.name) || "Member";
          if (io) {
            io.to("MAIN").emit("door:authorization", {
              authorized: true,
              name,
              reason: "Access Granted: Plan Active"
            });
          }
          console.log(`[adms] Access granted for member: ${name}`);
        } else if (io) {
          io.to("MAIN").emit("door:authorization", {
            authorized: false,
            reason: "Access Denied: Expired Plan"
          });
        }
      }
    } catch (err) {
      console.error("[adms] verification hook internal error:", err);
    }
  }

  // 2. CRUCIAL HARD RESET CONNECTION RESPONSE BLOCK
  // We send the absolute native ZK string layout matching the device protocol
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Connection": "close"
  });

  if (table === "ATTLOG") {
    res.end(`OK\ncount=1\nOK:${stamp}\n`);
  } else if (table === "OPERLOG") {
    res.end(`GB_OK\n${stamp}\n`);
  } else {
    res.end(`OK\n`);
  }
}

async function handleDeviceCmd(req, res, url, body) {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("OK\n");
}

module.exports = {
  handleRegistry,
  handleGetRequest,
  handleCdata,
  handleDeviceCmd
};
