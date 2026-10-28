/*
 * Test script: Manually emit a door:authorization event via Socket.IO
 * Run from backend directory: node firmware/esp32_door_client/test_emit.js
 * 
 * Use this to test ESP32 firmware without triggering a real scanner event.
 */

const { Server } = require("socket.io");
const { createServer } = require("http");
const crypto = require("crypto");

// ============================================================
// CONFIGURATION
// ============================================================
const GYM_ID = "MAIN";           // Your gym ID
const SOCKET_PORT = 3001;        // Temporary port for test server (not your main backend)
// ============================================================

// Create a minimal Socket.IO server for testing
const httpServer = createServer();
const io = new Server(httpServer, {
  cors: { origin: "*" }
});

io.on("connection", (socket) => {
  const gymId = socket.handshake.query.gymId;
  if (gymId) {
    socket.join(gymId);
    socket.emit("connected", { message: `Joined realtime for gym: ${gymId}` });
  }
  socket.on("joinGym", (id) => { if (id) socket.join(id); });
  
  console.log(`Client connected: ${socket.id}, gym: ${gymId}`);
});

httpServer.listen(SOCKET_PORT, () => {
  console.log(`Test Socket.IO server listening on port ${SOCKET_PORT}`);
  console.log(`Connect ESP32 to: ws://localhost:${SOCKET_PORT}/socket.io/?EIO=4&transport=websocket`);
  
  // Wait a moment for ESP32 to connect, then emit test event
  setTimeout(() => {
    emitTestAuthorization();
  }, 3000);
});

function emitTestAuthorization() {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 15000).toISOString();
  
  const payload = {
    token,
    expiresAt,
    scannerId: "TEST-SCANNER-001",
    memberId: "mem_test_123",
    attendanceId: "att_test_456"
  };
  
  console.log("\n=== Emitting test door:authorization ===");
  console.log("Payload:", JSON.stringify(payload, null, 2));
  
  io.to(GYM_ID).emit("door:authorization", payload);
  
  console.log("\nEvent emitted. Check ESP32 Serial Monitor.");
  console.log("Press Ctrl+C to stop test server.\n");
}