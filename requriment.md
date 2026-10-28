# A1 Fitness — ESP32 to Backend Communication
## Technical Handover and Troubleshooting Report

**Project:** A1 Fitness Gym Membership Management System  
**Current task:** Establish reliable, two-way communication between an ESP32 and the A1 Fitness Node.js backend using Socket.IO.  
**Current status:** Backend communication works with a Node.js client, but the ESP32 connection is failing. Root cause not yet confirmed.

---

## 1. Overall Project Goal

We are developing a hardware-integrated access-control system for A1 Fitness.

The intended architecture is:

**Fingerprint Scanner → ESP32/Gateway → Wi-Fi → Node.js Backend → MongoDB → Authorization Result → Door Controller**

The system should eventually:

1. Receive a fingerprint verification event from the biometric device.
2. Identify the corresponding gym member.
3. Send the necessary identification data to the backend.
4. Verify the member's gym, branch, and membership status.
5. Authorize access only when the membership is active.
6. Communicate the authorization result back to the hardware.
7. Activate the door lock only when authorization is granted.
8. Reject access when the membership is inactive or authorization fails.

The immediate task is deliberately narrower: **make ESP32-to-backend communication work reliably before integrating biometric events or door control.**

No door-unlock operation, membership authorization, or token redemption should be activated during this communication test.

---

## 2. Current Hardware and Software

### Hardware

- ESP32-WROOM-32 development board.
- Arduino IDE.
- Wi-Fi connection to the local router.
- Windows laptop running the backend.
- ESP32 and laptop are on the same local network.

### ESP32 network details

| Item | Current value |
|---|---|
| ESP32 IP | `192.168.31.114` |
| Backend laptop IP | `192.168.31.222` |
| Backend HTTP port | `5000` |
| Gym ID used in testing | `MAIN` |
| Wi-Fi status | Connected |
| Latest reported RSSI | `-37 dBm` |

The Wi-Fi password is intentionally omitted from this report.

### ESP32 libraries

The Arduino sketch uses:

- `WiFi.h`
- `SocketIOclient.h`
- `ArduinoJson.h`

The installed WebSockets library is **WebSockets by Markus Sattler, version 2.7.2**, using the Socket.IO client implementation associated with the links2004/arduinoWebSockets library.

### Backend

Project directory:

`C:\Users\ranbi\OneDrive\Desktop\Documents\a1fitnesslivecloud`

The backend uses Node.js, Socket.IO, and MongoDB.

Relevant services:

- HTTP server: port `5000`
- ADMS service: port `8082`
- MongoDB connection: successful in the previously observed backend logs

The ADMS service is not the current focus. We are troubleshooting Socket.IO communication only.

---

## 3. What Has Already Been Verified

### A. ESP32 Wi-Fi connection works

The serial output confirms:

- Wi-Fi initialization succeeds.
- The ESP32 associates with the router.
- It receives IP address `192.168.31.114`.
- The signal strength is strong.

Example:

```text
[SUCCESS] Wi-Fi connected
ESP32 IP: 192.168.31.114
Wi-Fi RSSI: -37 dBm
```

**Conclusion:** The ESP32 can connect to the Wi-Fi network. The immediate failure is occurring after Wi-Fi initialization.

### B. Backend HTTP service is reachable

The following request was tested from the Windows laptop:

```powershell
curl.exe -i http://192.168.31.222:5000/
```

The backend returned HTTP 200.

**Conclusion:** The backend's HTTP service is running and responds locally.

This does not, by itself, prove that every device on the network can establish a WebSocket connection.

### C. Socket.IO polling handshake works

The following request returned a valid Engine.IO response:

```powershell
curl.exe -i "http://192.168.31.222:5000/socket.io/?EIO=4&transport=polling"
```

The response contained:

```text
0{"sid":"...","upgrades":["websocket"],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}
```

This establishes that the backend's Socket.IO/Engine.IO endpoint responds to a polling handshake and advertises WebSocket upgrade support.

However, it does not prove that the ESP32 can complete the WebSocket handshake.

### D. A Node.js Socket.IO client works

A local test using:

```powershell
node .\test-socketio.js
```

successfully connected to the backend and joined the `MAIN` room.

The backend's Socket.IO connection handler appears to work with this client.

**Conclusion:** The backend is not completely broken. The remaining problem appears specific to the ESP32 connection path, its WebSocket client configuration, or an interaction between the client and server.

This is a working hypothesis, not a confirmed root cause.

---

## 4. Backend Implementation Already Present

The backend initializes Socket.IO in `server.js` around line 126:

```javascript
const io = new Server(server, {
  cors: corsOptions
});

app.locals.io = io;
initRealtime(io);
```

The Socket.IO connection handler is around line 397.

It reads:

```javascript
socket.handshake.query.gymId
```

It joins the appropriate room when the gym ID is provided and emits a `connected` event.

The ESP32 currently supplies:

```text
gymId=MAIN
```

The existing backend handler and the Node.js test indicate that basic Socket.IO functionality is available.

### Important caution about CORS

The backend has logged messages resembling:

```text
CORS BLOCKED: file://
```

These may originate from unrelated browser requests.

Do not change CORS configuration or allow `file://` origins merely because these messages appear. We do not currently have evidence that they cause the ESP32 connection failure.

---

## 5. Current ESP32 Sketch Behavior

The sketch constructs the Socket.IO endpoint approximately as follows:

```cpp
socketIOPath =
    "/socket.io/?EIO=4&transport=websocket&gymId=" +
    String(GYM_ID);

socketIO.onEvent(onSocketIOEvent);

socketIO.begin(
    BACKEND_HOST,
    BACKEND_PORT,
    socketIOPath.c_str()
);
```

The configuration includes:

```text
Backend host: 192.168.31.222
Backend port: 5000
Gym ID: MAIN
```

The event handler logs connection-related events, including:

- CONNECT
- DISCONNECT
- EVENT
- ERROR

When the Socket.IO client reports a successful connection, the sketch emits the Socket.IO root namespace connection event.

The main loop calls:

```cpp
socketIO.loop();
```

The sketch also retries the connection periodically.

The test mode explicitly avoids authorization and physical door control.

---

## 6. Exact Current Failure

The latest logs show repeated connection attempts followed by disconnection.

The critical error is:

```text
[E][NetworkClient.cpp:234] connect(): socket: 23
[WARN] Socket.IO disconnected
```

The same error repeats many times.

The ESP32 can initially connect to Wi-Fi, but it never reports a successful Socket.IO connection.

A typical sequence looks like:

```text
[SUCCESS] Wi-Fi connected
ESP32 IP: 192.168.31.114
Wi-Fi RSSI: -37 dBm

Connecting to Socket.IO at
http://192.168.31.222:5000/socket.io/?EIO=4&transport=websocket&gymId=MAIN

[INFO] Socket.IO connection attempt started
[WARN] Socket.IO disconnected
```

Later attempts produce repeated `socket: 23` errors.

### What this error tells us

It is a network-client connection failure that needs to be investigated at the socket creation/connection layer.

The available logs do not establish whether the underlying cause is:

- A resource or socket-allocation problem.
- A client-library state or reconnection problem.
- A WebSocket handshake or protocol mismatch.
- An endpoint or connection configuration issue.
- Another lower-level network-client failure.

Do not declare any one of these to be the confirmed cause until the relevant diagnostics establish it.

---

## 7. WebSocket Debugging Investigation

The sketch currently contains:

```cpp
#define WEBSOCKETS_LOGLEVEL WEBSOCKETS_LOGLEVEL_ALL

#include <WiFi.h>
#include <SocketIOclient.h>
#include <ArduinoJson.h>
```

The installed library source was inspected using PowerShell.

The relevant file is:

```text
C:\Users\ranbi\OneDrive\Desktop\Documents\Arduino\libraries\WebSockets\src\WebSockets.h
```

The search showed the following macro behavior:

```cpp
#ifndef DEBUG_WEBSOCKETS
#define DEBUG_WEBSOCKETS(...)
#ifndef NODEBUG_WEBSOCKETS
#define NODEBUG_WEBSOCKETS
#endif
#endif
```

The library defines `DEBUG_WEBSOCKETS` as an empty macro when its debugging configuration is not enabled through the expected mechanism.

Although the sketch defines `WEBSOCKETS_LOGLEVEL`, the library also uses its own `DEBUG_WEBSOCKETS` mechanism. Therefore, the expected low-level handshake diagnostics have not appeared in the serial output.

The source files contain diagnostic statements related to WebSocket initialization, handshake requests/responses, status codes, and handshake failures.

### Current status of debugging

We have not yet established whether the WebSockets library is actually compiling with the intended low-level diagnostics enabled.

This is an unresolved part of the investigation, not a confirmed cause of the connection failure.

---

## 8. What Has Gone Wrong in the Troubleshooting Process

Several diagnostic steps have been repeated without producing a root-cause diagnosis.

The following are already established:

- Wi-Fi works.
- The backend HTTP endpoint responds.
- The Socket.IO polling endpoint responds.
- A Node.js Socket.IO client successfully connects.
- The ESP32 repeatedly fails.
- The low-level WebSocket diagnostic configuration remains unverified.

Repeating Wi-Fi checks, HTTP checks, and basic backend checks will not be useful unless new evidence contradicts these findings.

**The next investigation should focus on the ESP32's actual WebSocket connection attempt and the exact meaning and origin of the `socket: 23` error.**

The solution should be evidence-driven rather than based on repeated speculative changes.

---

## 9. Recommended Fixing Strategy

Follow these phases in order. Do not jump directly to membership authorization or hardware control.

### Phase 1 — Establish reliable diagnostics

Inspect the complete sketch and the installed library's actual debug configuration.

Determine why the library's handshake diagnostics are not appearing.

Enable the supported low-level debugging mechanism for the installed library and verify that the expected diagnostic messages appear after compilation and upload.

Capture one complete connection attempt, including:

- WebSocket client initialization.
- TCP connection attempt.
- WebSocket handshake request.
- HTTP response or failure.
- Socket.IO connection status.
- Disconnect reason, where available.

Do not make unrelated backend changes during this phase.

### Phase 2 — Inspect the actual failing connection

Use the new diagnostic output to determine where the failure occurs.

Specifically establish:

1. Does the ESP32 successfully open a TCP socket?
2. Does it send an HTTP WebSocket upgrade request?
3. Does the backend receive the request?
4. Does the server return a valid WebSocket upgrade response?
5. Does the client correctly process the Engine.IO and Socket.IO connection packets?
6. Does the connection fail because of the network client, protocol negotiation, or a later stage?

Compare the ESP32 attempt with the already successful Node.js Socket.IO test.

Only change the component implicated by the evidence.

### Phase 3 — Implement the smallest verified correction

Once the root cause is identified, implement the smallest relevant correction.

Possible areas to inspect include:

- ESP32 WebSocket client initialization and configuration.
- Socket.IO endpoint construction and protocol compatibility.
- Library debug/build configuration.
- Socket creation and cleanup.
- Reconnection logic and connection lifecycle.
- Any confirmed server/client protocol mismatch.

These are investigation areas, not a list of confirmed bugs.

Avoid simultaneously changing the ESP32 sketch, backend Socket.IO initialization, CORS, router settings, and library versions. That would make the actual cause harder to identify.

### Phase 4 — Prove stable communication

The ESP32 should be able to:

1. Connect to Wi-Fi.
2. Establish a Socket.IO connection.
3. Receive the backend's `connected` event.
4. Join the `MAIN` room.
5. Send a harmless test event.
6. Receive an acknowledgement or test response.
7. Remain connected without repeated disconnects.
8. Recover correctly after a controlled network interruption.

The test should use harmless communication events only.

### Phase 5 — Integrate actual hardware authorization later

Only after Phase 4 passes should the project proceed to biometric integration.

That later phase will require separate testing of:

- Scanner identity mapping.
- Gym and branch identification.
- Membership verification.
- Secure authorization messages.
- Active-membership enforcement.
- Failure handling when the backend is unavailable.
- Door controller and relay safety.
- Audit logs and duplicate-event handling.

A successful Socket.IO connection alone does not prove that access control is secure or correct.

---

## 10. Required Final Output

The immediate deliverable is a working, tested ESP32-to-Node.js Socket.IO communication path.

### Required success criteria

| Requirement | Expected result |
|---|---|
| ESP32 Wi-Fi connection | Successful |
| Backend TCP/HTTP reachability | Successful |
| WebSocket handshake | Successful |
| Socket.IO connection | Successful |
| Gym ID transmission | `MAIN` |
| Backend `connected` event | Received by ESP32 |
| Room joining | Confirmed by backend |
| ESP32-to-backend test event | Successfully delivered |
| Backend-to-ESP32 test response | Successfully received |
| Connection stability | No repeated unexplained disconnects |
| Reconnection | Recovers after a controlled interruption |
| Door relay operation | Disabled during communication testing |
| Membership authorization | Not activated during communication testing |

### Expected deliverables

1. A corrected ESP32 Arduino sketch.
2. Any necessary, evidence-based backend changes.
3. A clear explanation of the confirmed root cause.
4. A successful serial log showing connection and test-event exchange.
5. A successful backend log confirming the ESP32 connection and room membership.
6. A repeatable test procedure.
7. A clear statement of any remaining limitations.

The setup should not be considered complete merely because the ESP32 reports that a connection attempt has started.

---

## 11. Important Rules for Whoever Continues This Work

- Preserve the existing project and Wi-Fi configuration unless a specific change is justified.
- Never expose the Wi-Fi password or other credentials in reports or logs.
- Do not enable real token redemption, member authorization, attendance recording, or relay control while diagnosing connectivity.
- Do not allow `file://` origins in CORS as an experimental fix.
- Do not replace the backend architecture without evidence that it is necessary.
- Do not repeatedly ask the user to rerun tests that have already passed.
- Prefer inspecting the actual source files and logs before requesting another upload.
- Make one targeted change at a time.
- After each change, explain what it is intended to prove and what result would confirm or reject the hypothesis.

---

## Final Status

**The project is not yet at the working Socket.IO communication stage.**

The backend has been shown to work with a Node.js Socket.IO client, and the ESP32 can connect to Wi-Fi. However, the ESP32 repeatedly fails with `NetworkClient.cpp:234 connect(): socket: 23`, and a successful WebSocket/Socket.IO session has not been demonstrated.

The next developer should begin by diagnosing the ESP32's low-level socket and WebSocket connection attempt, establish the actual failure point, and then apply a targeted fix.

The overall objective remains a reliable, two-way ESP32-to-backend communication system that can later serve as the foundation for secure A1 Fitness membership-based door access.