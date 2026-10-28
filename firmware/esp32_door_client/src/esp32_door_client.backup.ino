/*
 * A1 Fitness ESP32 Door Client
 *
 * Connects to backend via Socket.IO (TLS), joins gym room,
 * listens for door:authorization events.
 *
 * Hardware: ESP32-WROOM-32 DevKit
 * Framework: Arduino
 * Libraries: SocketIOclient (from links2004/arduinoWebSockets), ArduinoJson
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <SocketIOclient.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>

// ============================================================
// CONFIGURATION - CHANGE THESE VALUES
// ============================================================
const char *WIFI_SSID = "YOUR_WIFI_SSID";
const char *WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// Backend URL (Render HTTPS URL, e.g., "wss://a1-fitness-backend.onrender.com")
const char *BACKEND_HOST = "YOUR_BACKEND_HOST"; // e.g., "a1-fitness-backend.onrender.com"
const int BACKEND_PORT = 443;

// Gym ID (must match your gymId in MongoDB, e.g., "MAIN")
const char *GYM_ID = "MAIN";

// ESP32 Controller credentials (must match DoorController document in MongoDB)
const char *CONTROLLER_ID = "ESP32-001";
const char *CONTROLLER_KEY = "YOUR_CONTROLLER_SECRET_KEY";

// ============================================================
// CONSTANTS
// ============================================================
const char *REDEEM_PATH = "/api/scanners/door-authorizations/redeem";

// Socket.IO path with gymId query param so server auto-joins the gym room
String socketIOPath;

// ============================================================
// GLOBALS
// ============================================================
WiFiClientSecure secureClient;
SocketIOclient socketIO;
bool wifiConnected = false;
bool socketConnected = false;
unsigned long lastReconnectAttempt = 0;
const unsigned long RECONNECT_INTERVAL_MS = 10000;

// ============================================================
// HELPER: Print to Serial with timestamp
// ============================================================
void logMsg(const char *level, const char *msg)
{
  Serial.printf("[%lu] [%s] %s\n", millis(), level, msg);
}

// ============================================================
// SOCKET.IO EVENT HANDLER
// ============================================================
void onSocketIOEvent(socketIOmessageType_t type, uint8_t *payload, size_t length)
{
  switch (type)
  {
  case sIOtype_DISCONNECT:
    logMsg("WARN", "Socket.IO disconnected");
    socketConnected = false;
    break;

  case sIOtype_CONNECT:
    logMsg("INFO", "Socket.IO connected");
    socketConnected = true;
    // Join default namespace (required for Socket.IO v3+)
    socketIO.send(sIOtype_CONNECT, "/");
    break;

  case sIOtype_EVENT:
  {
    // Payload format: ["eventName", data] or ["eventName", data, ackId]
    if (!payload || length == 0)
      break;

    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, payload, length);
    if (err)
    {
      logMsg("ERROR", "Failed to parse Socket.IO event JSON");
      break;
    }

    // doc[0] = event name, doc[1] = data
    const char *eventName = doc[0] | "";
    JsonVariant data = doc[1];

    if (strcmp(eventName, "connected") == 0)
    {
      logMsg("INFO", "Received 'connected' event from server");
      if (!data.isNull())
      {
        serializeJson(data, Serial);
        Serial.println();
      }
    }
    else if (strcmp(eventName, "door:authorization") == 0)
    {
      handleDoorAuthorization(data);
    }
    else
    {
      logMsg("INFO", "Received unhandled event");
      Serial.printf("  Event: %s\n", eventName);
    }
    break;
  }

  case sIOtype_ACK:
    logMsg("INFO", "Received ACK");
    break;

  case sIOtype_ERROR:
    logMsg("ERROR", "Socket.IO error");
    if (payload && length > 0)
    {
      Serial.printf("  Payload: %.*s\n", length, payload);
    }
    break;

  case sIOtype_BINARY_EVENT:
  case sIOtype_BINARY_ACK:
    logMsg("WARN", "Received binary event (not supported)");
    break;
  }
}

void handleDoorAuthorization(JsonVariant data)
{
  logMsg("INFO", "=== DOOR AUTHORIZATION RECEIVED ===");

  if (data.isNull())
  {
    logMsg("ERROR", "Empty payload");
    return;
  }

  Serial.printf("Raw payload: ");
  serializeJson(data, Serial);
  Serial.println();

  // Extract fields
  const char *token = data["token"] | "";
  const char *expiresAt = data["expiresAt"] | "";
  const char *scannerId = data["scannerId"] | "";
  const char *memberId = data["memberId"] | "";
  const char *attendanceId = data["attendanceId"] | "";

  if (strlen(token) == 0)
  {
    logMsg("ERROR", "Token missing in payload");
    return;
  }

  logMsg("INFO", "Parsed authorization:");
  Serial.printf("  Token: %s...\n", token);
  Serial.printf("  Expires: %s\n", expiresAt);
  Serial.printf("  Scanner: %s\n", scannerId);
  Serial.printf("  Member: %s\n", memberId);
  Serial.printf("  Attendance: %s\n", attendanceId);

  // Call redemption endpoint
  redeemToken(token);
}

// ============================================================
// HTTP REDEMPTION
// ============================================================
void redeemToken(const char *token)
{
  logMsg("INFO", "Calling redemption endpoint...");

  HTTPClient http;
  String url = "https://";
  url += BACKEND_HOST;
  url += REDEEM_PATH;

  http.begin(secureClient, url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-controller-id", CONTROLLER_ID);
  http.addHeader("x-controller-key", CONTROLLER_KEY);

  // Build JSON body
  JsonDocument bodyDoc;
  bodyDoc["token"] = token;
  String bodyStr;
  serializeJson(bodyDoc, bodyStr);

  int httpCode = http.POST(bodyStr);

  if (httpCode > 0)
  {
    String response = http.getString();
    logMsg("INFO", "Redemption response:");
    Serial.printf("  HTTP %d\n", httpCode);
    Serial.printf("  Body: %s\n", response.c_str());

    if (httpCode == 200)
    {
      JsonDocument respDoc;
      deserializeJson(respDoc, response);
      bool authorized = respDoc["data"]["authorized"] | false;
      if (authorized)
      {
        logMsg("SUCCESS", "Door authorized! (Relay would activate here)");
      }
      else
      {
        logMsg("WARN", "Token not authorized");
      }
    }
    else if (httpCode == 403)
    {
      logMsg("WARN", "Token invalid, expired, or already used");
    }
    else if (httpCode == 401)
    {
      logMsg("ERROR", "Controller authentication failed - check credentials");
    }
  }
  else
  {
    logMsg("ERROR", "HTTP request failed");
    Serial.printf("  Error: %s\n", http.errorToString(httpCode).c_str());
  }

  http.end();
}

// ============================================================
// WIFI SETUP
// ============================================================
void connectWiFi()
{
  logMsg("INFO", "Connecting to WiFi...");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30)
  {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED)
  {
    wifiConnected = true;
    logMsg("INFO", "WiFi connected");
    Serial.printf("  IP: %s\n", WiFi.localIP().toString().c_str());
    Serial.printf("  RSSI: %d dBm\n", WiFi.RSSI());
  }
  else
  {
    wifiConnected = false;
    logMsg("ERROR", "WiFi connection failed");
  }
}

// ============================================================
// SOCKET.IO SETUP
// ============================================================
void setupSocketIO()
{
  // Skip certificate verification for testing
  // TODO: For production, load the Render root CA certificate
  secureClient.setInsecure();

  // Build Socket.IO path with gymId query param so server auto-joins the gym room
  socketIOPath = "/socket.io/?EIO=4&transport=websocket&gymId=" + String(GYM_ID);

  // Socket.IO connection over SSL (wss://)
  socketIO.beginSSL(BACKEND_HOST, BACKEND_PORT, socketIOPath.c_str());

  // Register event handler
  socketIO.onEvent(onSocketIOEvent);

  logMsg("INFO", "Socket.IO client initialized");
  Serial.printf("  Path: %s\n", socketIOPath.c_str());
}

// ============================================================
// RECONNECTION LOGIC
// ============================================================
void handleReconnection()
{
  if (!wifiConnected)
  {
    connectWiFi();
    if (wifiConnected)
    {
      setupSocketIO();
    }
    return;
  }

  if (!socketConnected)
  {
    unsigned long now = millis();
    if (now - lastReconnectAttempt >= RECONNECT_INTERVAL_MS)
    {
      lastReconnectAttempt = now;
      logMsg("INFO", "Attempting Socket.IO reconnection...");
      // Reuse the same path with gymId so server restores room membership on reconnect
      socketIO.beginSSL(BACKEND_HOST, BACKEND_PORT, socketIOPath.c_str());
    }
  }
}

// ============================================================
// ARDUINO SETUP / LOOP
// ============================================================
void setup()
{
  Serial.begin(115200);
  delay(1000); // Wait for serial monitor

  logMsg("INFO", "=== A1 Fitness ESP32 Door Client Starting ===");
  Serial.printf("Gym ID: %s\n", GYM_ID);
  Serial.printf("Controller ID: %s\n", CONTROLLER_ID);
  Serial.printf("Backend: %s:%d\n", BACKEND_HOST, BACKEND_PORT);

  connectWiFi();
  if (wifiConnected)
  {
    setupSocketIO();
  }
}

void loop()
{
  // Handle reconnection
  handleReconnection();

  // Process Socket.IO events
  if (socketConnected)
  {
    socketIO.loop();
  }

  // Small delay to prevent watchdog reset
  delay(10);
}