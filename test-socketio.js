const { io } = require("socket.io-client");

const PORT = 5000;
const GYM_ID = "MAIN";

console.log(`[TEST] Connecting to http://localhost:${PORT} with gymId=${GYM_ID}...`);

const socket = io(`http://localhost:${PORT}`, {
  query: { gymId: GYM_ID },
  transports: ["websocket", "polling"],
  forceNew: true,
  reconnection: false,
});

let connected = false;

socket.on("connect", () => {
  connected = true;
  console.log(`[${new Date().toISOString()}] ✓ CONNECTED (socket.id: ${socket.id})`);
});

socket.on("connect_error", (err) => {
  console.log(`[${new Date().toISOString()}] ✗ CONNECT_ERROR: ${err.message}`);
});

socket.on("disconnect", (reason) => {
  console.log(`[${new Date().toISOString()}] DISCONNECTED: ${reason}`);
});

socket.on("connected", (data) => {
  console.log(`[${new Date().toISOString()}] ✓ JOINED ROOM:`, data);
});

socket.on("door:authorization", (data) => {
  console.log(`[${new Date().toISOString()}] ✓ DOOR:AUTHORIZATION received:`);
  console.log(JSON.stringify(data, null, 2));
});

socket.onAny((eventName, ...args) => {
  if (!["connect", "connect_error", "disconnect", "connected", "door:authorization"].includes(eventName)) {
    console.log(`[${new Date().toISOString()}] EVENT: ${eventName}`, args);
  }
});

// Auto-disconnect after 30 seconds
setTimeout(() => {
  console.log(`\n[${new Date().toISOString()}] Timeout reached. Disconnecting...`);
  socket.disconnect();
  process.exit(0);
}, 30000);

// Handle process termination
process.on("SIGINT", () => {
  console.log("\nInterrupted. Disconnecting...");
  socket.disconnect();
  process.exit(0);
});

console.log("[TEST] Waiting for events (30s timeout)...\n");