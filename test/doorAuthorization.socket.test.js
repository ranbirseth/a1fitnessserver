const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const { Server } = require("socket.io");
const { io: createClient } = require("socket.io-client");
const { emitToGym, initRealtime } = require("../services/realtime.service");

const GYM_ID = "MAIN";
const OTHER_GYM_ID = "OTHER";
const SCANNER_ID = "TEST-SCANNER-BR2-001";
const MEMBER_ID = "test-member";
const ATTENDANCE_ID = "test-attendance";

let httpServer;
let socketServer;
let serverUrl;
const clients = [];

before(async () => {
  httpServer = http.createServer();
  socketServer = new Server(httpServer);
  initRealtime(socketServer);

  socketServer.on("connection", (socket) => {
    const gymId = socket.handshake.query.gymId;
    if (gymId) socket.join(gymId);
  });

  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolve);
  });

  serverUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
  for (const client of clients) client.disconnect();

  if (socketServer) {
    await new Promise((resolve) => socketServer.close(resolve));
  }
});

function connectClient(gymId) {
  const socket = createClient(serverUrl, {
    query: { gymId },
    transports: ["websocket"],
    forceNew: true,
    reconnection: false
  });
  clients.push(socket);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Socket connection timed out")), 3000);
    socket.once("connect", () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function mockIssueAuthorization() {
  return {
    token: crypto.randomBytes(24).toString("hex"),
    expiresAt: new Date(Date.now() + 15000)
  };
}

async function mockProcessCheckin({ scanner, member, attendance }) {
  const authorization = await mockIssueAuthorization();
  emitToGym(scanner.gymId, "door:authorization", {
    token: authorization.token,
    expiresAt: authorization.expiresAt,
    scannerId: scanner.deviceId,
    memberId: member.id,
    attendanceId: attendance.id
  });
}

test("door authorization reaches MAIN only with required payload fields", async () => {
  const mainClient = await connectClient(GYM_ID);
  const otherGymClient = await connectClient(OTHER_GYM_ID);

  let otherGymReceived = false;
  const doorEvent = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Door event timed out")), 3000);
    mainClient.once("door:authorization", (payload) => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });

  otherGymClient.on("door:authorization", () => {
    otherGymReceived = true;
  });

  await mockProcessCheckin({
    scanner: { gymId: GYM_ID, deviceId: SCANNER_ID },
    member: { id: MEMBER_ID },
    attendance: { id: ATTENDANCE_ID }
  });
  const receivedPayload = await doorEvent;

  assert.ok(receivedPayload);
  assert.equal(typeof receivedPayload.token, "string");
  assert.ok(receivedPayload.token.length > 0);
  assert.ok(receivedPayload.expiresAt);
  assert.ok(Number.isFinite(Date.parse(receivedPayload.expiresAt)));
  assert.equal(receivedPayload.scannerId, SCANNER_ID);
  assert.equal(receivedPayload.memberId, MEMBER_ID);
  assert.equal(receivedPayload.attendanceId, ATTENDANCE_ID);

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(otherGymReceived, false);
});
