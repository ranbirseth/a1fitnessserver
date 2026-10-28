#include <WiFi.h>
#include <SocketIOclient.h>
#include <ArduinoJson.h>

const char *WIFI_SSID = "Ranbir";
const char *WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char *BACKEND_HOST = "192.168.31.222";
const uint16_t BACKEND_PORT = 5000;
const char *GYM_ID = "MAIN";

const int RELAY_PIN = 4;

SocketIOclient socketIO;
bool socketConnected = false;

void onSocketIOEvent(socketIOmessageType_t type, uint8_t *payload, size_t length) {
  if (type == sIOtype_CONNECT) {
    Serial.println("\n[SUCCESS] Socket.IO Connected to Server!");
    socketIO.send(sIOtype_CONNECT, "/");
    socketConnected = true;
  }
  else if (type == sIOtype_DISCONNECT) {
    Serial.println("\n[WARN] Socket.IO Disconnected.");
    socketConnected = false;
  }
  else if (type == sIOtype_EVENT) {
    DynamicJsonDocument doc(1024);
    if (deserializeJson(doc, payload, length)) return;

    const char *eventName = doc[0] | "";

    if (strcmp(eventName, "door:authorization") == 0) {
      JsonObject data = doc[1];
      bool authorized = data["authorized"] | false;

      if (authorized) {
        Serial.println("\n=============================================");
        Serial.printf("[ACCESS GRANTED] Opening door for: %s\n", data["name"] | "User");
        Serial.println("[ACTION] Triggering Relay PIN 4: CUTTING MAGNET POWER NOW...");

        digitalWrite(RELAY_PIN, HIGH);
        delay(5000);

        digitalWrite(RELAY_PIN, LOW);

        Serial.println("[ACTION] Relay PIN 4 Reset: Power restored. Door Locked.");
        Serial.println("=============================================");
      } else {
        Serial.printf("\n[ACCESS REJECTED] Door remains locked. Reason: %s\n", data["reason"] | "Unknown");
      }
    }
  }
}

void setup() {
  Serial.begin(115200);

  pinMode(RELAY_PIN, OUTPUT_OPEN_DRAIN);
  digitalWrite(RELAY_PIN, LOW);

  Serial.print("\nConnecting to Wi-Fi...");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.printf("\nConnected! IP: %s\n", WiFi.localIP().toString().c_str());

  socketIO.begin(BACKEND_HOST, BACKEND_PORT, ("/socket.io/?EIO=4&transport=websocket&gymId=" + String(GYM_ID)).c_str());
  socketIO.onEvent(onSocketIOEvent);
  socketIO.setExtraHeaders("User-Agent: Mozilla/5.0\r\nOrigin: http://localhost:3000");
}

void loop() {
  socketIO.loop();
}
