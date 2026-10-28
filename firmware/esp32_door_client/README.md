# A1 Fitness ESP32 Door Client

Minimal firmware to test Socket.IO communication with the A1 Fitness backend.

## Files
- `esp32_door_client.ino` — Main firmware
- `platformio.ini` — PlatformIO project config

## Software to Install

1. **VS Code** (recommended) — https://code.visualstudio.com/
2. **PlatformIO Extension** — Open VS Code, Extensions (Ctrl+Shift+X), search "PlatformIO IDE", install
3. **USB Driver** (if needed) — CP210x or CH340 driver for your ESP32 board

## Configuration (Edit `esp32_door_client.ino`)

Change these values in the CONFIGURATION section:

```cpp
const char* WIFI_SSID       = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD   = "YOUR_WIFI_PASSWORD";
const char* BACKEND_HOST    = "YOUR_BACKEND_HOST";  // e.g., "a1-fitness-backend.onrender.com"
const char* GYM_ID          = "MAIN";               // Must match your gymId in MongoDB
const char* CONTROLLER_ID   = "ESP32-001";          // Must match DoorController.controllerId
const char* CONTROLLER_KEY  = "YOUR_CONTROLLER_SECRET_KEY";  // Plaintext key (server hashes it)
```

## Upload Firmware

1. Connect ESP32 via USB
2. Open project in VS Code (File → Open Folder → `firmware/esp32_door_client`)
3. PlatformIO toolbar → **Upload** (arrow icon) or `Ctrl+Alt+U`
4. Open **Serial Monitor** (plug icon) at 115200 baud

## Test Connection

### 1. Verify Backend is Running
```bash
# Local
curl https://your-backend.onrender.com/api/health

# Should return { "success": true, "data": { "dbReady": true, ... } }
```

### 2. Create DoorController in MongoDB
```javascript
// In MongoDB shell (mongosh)
use gymza
db.doorcontrollers.insertOne({
  controllerId: "ESP32-001",
  controllerKeyHash: "a1b2c3d4...",  // SHA256 of your CONTROLLER_KEY
  gymId: "MAIN",
  branchCode: "MAIN",
  allowedScannerIds: ["YOUR_SCANNER_DEVICE_ID"],
  status: "online"
})
```
> Generate hash: `node -e "console.log(require('crypto').createHash('sha256').update('YOUR_CONTROLLER_SECRET_KEY').digest('hex'))"`

### 3. Trigger Test Authorization
Option A: Via scanner event API (if scanner registered)
```bash
curl -X POST https://your-backend.onrender.com/api/scanners/events \
  -H "Content-Type: application/json" \
  -H "x-scanner-id: YOUR_SCANNER_DEVICE_ID" \
  -H "x-scanner-key: YOUR_SCANNER_API_KEY" \
  -d '{"events":[{"userId":"1001","verified":true,"eventType":"fingerprint","timestamp":"2026-10-25T10:00:00Z","deviceEventId":"test-1"}]}'
```

Option B: Direct DB insert (for testing without scanner)
```javascript
use gymza
const crypto = require('crypto');
const token = crypto.randomBytes(32).toString('base64url');
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
db.doorauthorizations.insertOne({
  gymId: "MAIN",
  branchCode: "MAIN",
  scanner: ObjectId("SCANNER_OBJECT_ID"),
  deviceId: "YOUR_SCANNER_DEVICE_ID",
  member: ObjectId("MEMBER_OBJECT_ID"),
  attendance: ObjectId("ATTENDANCE_OBJECT_ID"),
  scannerEvent: ObjectId("SCANNEREVENT_OBJECT_ID"),
  tokenHash: tokenHash,
  status: "pending",
  expiresAt: new Date(Date.now() + 15000)
})
// Then manually trigger emit via server console or test script
```

### 4. Watch Serial Monitor
Expected output:
```
[1234] [INFO] === A1 Fitness ESP32 Door Client Starting ===
[1234] [INFO] Gym ID: MAIN
[1234] [INFO] Controller ID: ESP32-001
[1234] [INFO] Backend: your-backend.onrender.com:443
[1234] [INFO] Connecting to WiFi...
[2345] [INFO] WiFi connected
[2345] [INFO]   IP: 192.168.1.42
[2345] [INFO]   RSSI: -45 dBm
[2345] [INFO] Socket.IO client initialized
[3456] [INFO] Socket.IO connected
[3456] [INFO] Sent joinGym event
[3456] [INFO] Received 'connected' event from server
  Payload: {"message":"Joined realtime for gym: MAIN"}
[...wait for scanner event...]
[99999] [INFO] === DOOR AUTHORIZATION RECEIVED ===
Raw payload: {"token":"abc123...","expiresAt":"2026-10-25T10:00:15.000Z","scannerId":"SCAN-001","memberId":"mem_123","attendanceId":"att_456"}
[99999] [INFO] Parsed authorization:
  Token: abc123...
  Expires: 2026-10-25T10:00:15.000Z
  Scanner: SCAN-001
  Member: mem_123
  Attendance: att_456
[99999] [INFO] Calling redemption endpoint...
[10050] [INFO] Redemption response:
  HTTP 200
  Body: {"success":true,"message":"Door authorization accepted","data":{"authorized":true,"expiresAt":"2026-10-25T10:00:15.000Z"}}
[10050] [SUCCESS] Door authorized! (Relay would activate here)
```

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "Socket.IO connected" never appears | Check `BACKEND_HOST` (no `https://`, just hostname), verify Render allows WebSocket |
| "HTTP request failed" on redemption | Verify `CONTROLLER_ID`/`CONTROLLER_KEY` match DoorController doc |
| "Token invalid" (403) | Token expired (15s default) or already used; trigger new event |
| "Controller authentication failed" (401) | Check DoorController exists, `controllerKeyHash` matches SHA256 of `CONTROLLER_KEY` |
| WiFi fails | Check SSID/password, 2.4GHz only (ESP32 doesn't support 5GHz) |

## Security Notes
- `secureClient.setInsecure()` skips TLS cert verification (OK for testing)
- For production: download Render's root CA (ISRG Root X1) and use `secureClient.setCACert(rootCA)`
- Never commit real credentials to git