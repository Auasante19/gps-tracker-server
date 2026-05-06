// IMPORTANT: Define modem model BEFORE including TinyGSM
#define TINY_GSM_MODEM_SIM7600
#define TINY_GSM_USE_SSL

#include <Arduino.h>
#include <TinyGsmClient.h>
#include <ArduinoHttpClient.h>
#include <ArduinoJson.h>
#include <TinyGPSPlus.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

// ============================================================
//   CONFIGURATION — fill in your details here
// ============================================================

// WiFi credentials (fallback)
#define WIFI_SSID        "Acity-Guest"
#define WIFI_PASSWORD    "password@acity"

// APN for MTN Ghana
#define APN              "internet"
#define APN_USER         ""
#define APN_PASS         ""

// Supabase credentials
#define SERVER_HOST   "diplomatic-alignment-production-ebb5.up.railway.app"
#define SERVER_URL    "https://diplomatic-alignment-production-ebb5.up.railway.app/api/location"
// Device ID
#define DEVICE_ID        "tracker_01"

// How often to send GPS data (milliseconds)
#define UPDATE_INTERVAL  300000  // 5 minutes

// ============================================================
//   PIN DEFINITIONS for LilyGO SIM7600E
// ============================================================
#define MODEM_TX         27
#define MODEM_RX         26
#define MODEM_PWRKEY     4
#define MODEM_POWER_ON   25
#define MODEM_RST        5
#define GPS_RX           23
#define GPS_TX           22

// ============================================================
//   GLOBALS
// ============================================================
HardwareSerial SerialAT(1);   // UART1 for SIM7600
HardwareSerial SerialGPS(2);  // UART2 for GPS

TinyGsm        modem(SerialAT);
TinyGsmClient  gsmClient(modem);
TinyGPSPlus    gps;

bool useLTE  = false;
bool useWiFi = false;

unsigned long lastUpdate = 0;

// ============================================================
//   FUNCTION: Power on the SIM7600 modem
// ============================================================
void modemPowerOn() {
  Serial.println("[LTE] Powering on modem...");
  pinMode(MODEM_POWER_ON, OUTPUT);
  digitalWrite(MODEM_POWER_ON, HIGH);

  pinMode(MODEM_PWRKEY, OUTPUT);
  digitalWrite(MODEM_PWRKEY, LOW);
  delay(100);
  digitalWrite(MODEM_PWRKEY, HIGH);
  delay(1000);
  digitalWrite(MODEM_PWRKEY, LOW);
  delay(5000);
}

// ============================================================
//   FUNCTION: Try connecting via LTE
// ============================================================
bool connectLTE() {
  Serial.println("[LTE] Initialising modem...");
  SerialAT.begin(115200, SERIAL_8N1, MODEM_RX, MODEM_TX);
  delay(3000);

  modem.restart();
  String modemInfo = modem.getModemInfo();
  Serial.println("[LTE] Modem: " + modemInfo);

  Serial.println("[LTE] Waiting for network...");
  if (!modem.waitForNetwork(60000L)) {
    Serial.println("[LTE] Network failed");
    return false;
  }

  Serial.println("[LTE] Connecting to APN...");
  if (!modem.gprsConnect(APN, APN_USER, APN_PASS)) {
    Serial.println("[LTE] APN failed");
    return false;
  }

  Serial.println("[LTE] Connected! IP: " + modem.localIP().toString());
  return true;
}

// ============================================================
//   FUNCTION: Try connecting via WiFi
// ============================================================
bool connectWiFi() {
  Serial.println("[WiFi] Connecting to: " + String(WIFI_SSID));
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[WiFi] Connected! IP: " + WiFi.localIP().toString());
    return true;
  }

  Serial.println("\n[WiFi] Failed to connect");
  return false;
}

// ============================================================
//   FUNCTION: Enable GPS on SIM7600E via AT commands
// ============================================================
void enableGPS() {
  Serial.println("[GPS] Powering on GNSS via AT command...");
  
  // Turn off first in case it was already on
  SerialAT.println("AT+CGPS=0");
  delay(2000);
  while (SerialAT.available()) Serial.write(SerialAT.read());

  // Turn on GPS
  SerialAT.println("AT+CGPS=1,1");
  delay(2000);
  while (SerialAT.available()) Serial.write(SerialAT.read());

  // Check GPS status
  SerialAT.println("AT+CGPS?");
  delay(1000);
  while (SerialAT.available()) Serial.write(SerialAT.read());

  // Get GPS info
  SerialAT.println("AT+CGPSINFO");
  delay(1000);
  while (SerialAT.available()) Serial.write(SerialAT.read());

  Serial.println("[GPS] GNSS init complete");
}

// ============================================================
//   FUNCTION: Test GPS via AT command directly
// ============================================================
void testGPS() {
  Serial.println("[GPS] Testing GNSS module...");
  
  SerialAT.println("AT+CGPS?");
  delay(1000);
  while (SerialAT.available()) Serial.write(SerialAT.read());

  SerialAT.println("AT+CGPSINFO");
  delay(1000);
  while (SerialAT.available()) Serial.write(SerialAT.read());


  // Check signal strength
  SerialAT.println("AT+CSQ");
  delay(1000);
  while (SerialAT.available()) {
    Serial.write(SerialAT.read());
  }
}
// ============================================================
//   FUNCTION: Send GPS data to Supabase via LTE
// ============================================================
void sendViaLTE(float lat, float lng, float spd, float altitude, int satellites) {
  JsonDocument doc;
  doc["device_id"]  = DEVICE_ID;
  doc["latitude"]   = lat;
  doc["longitude"]  = lng;
  doc["speed"]      = spd;
  doc["altitude"]   = altitude;
  doc["satellites"] = satellites;

  String body;
  serializeJson(doc, body);

  Serial.println("[LTE] Sending via AT HTTPS: " + body);

  // Close any previous HTTP session
  SerialAT.println("AT+HTTPTERM");
  delay(1000);
  while (SerialAT.available()) SerialAT.read();

  // Initialize HTTP
  SerialAT.println("AT+HTTPINIT");
  delay(1000);
  while (SerialAT.available()) SerialAT.read();

  // Set SSL
  SerialAT.println("AT+HTTPSSL=1");
  delay(500);
  while (SerialAT.available()) SerialAT.read();

  // Set URL
  SerialAT.println("AT+HTTPPARA=\"URL\",\"https://diplomatic-alignment-production-ebb5.up.railway.app/api/location\"");
  delay(500);
  while (SerialAT.available()) SerialAT.read();

  // Set content type
  SerialAT.println("AT+HTTPPARA=\"CONTENT\",\"application/json\"");
  delay(500);
  while (SerialAT.available()) SerialAT.read();

  // Set data length and timeout
  SerialAT.println("AT+HTTPDATA=" + String(body.length()) + ",10000");
  delay(500);

  // Wait for DOWNLOAD prompt
  String prompt = "";
  long timeout = millis() + 5000;
  while (millis() < timeout) {
    if (SerialAT.available()) {
      prompt += (char)SerialAT.read();
      if (prompt.indexOf("DOWNLOAD") >= 0) break;
    }
  }
  Serial.println("[LTE] Prompt: " + prompt);

  // Send JSON body
  SerialAT.print(body);
  delay(2000);

  // Execute POST
  SerialAT.println("AT+HTTPACTION=1");
  delay(500);

  // Wait for response
  String response = "";
  timeout = millis() + 10000;
  while (millis() < timeout) {
    if (SerialAT.available()) {
      response += (char)SerialAT.read();
      if (response.indexOf("+HTTPACTION") >= 0) break;
    }
  }
  Serial.println("[LTE] Response: " + response);

  // Read response body
  SerialAT.println("AT+HTTPREAD");
  delay(1000);
  String responseBody = "";
  timeout = millis() + 3000;
  while (millis() < timeout) {
    if (SerialAT.available()) {
      responseBody += (char)SerialAT.read();
    }
  }
  Serial.println("[LTE] Body: " + responseBody);

  // Terminate HTTP
  SerialAT.println("AT+HTTPTERM");
  delay(500);
  while (SerialAT.available()) SerialAT.read();
}
// ============================================================
//   FUNCTION: Send GPS data to Supabase via WiFi
// ============================================================
void sendViaWiFi(float lat, float lng, float spd, float altitude, int satellites) {
  WiFiClientSecure client;
  client.setInsecure();

  HttpClient http(client, "diplomatic-alignment-production-ebb5.up.railway.app", 443);

  JsonDocument doc;
  doc["device_id"]  = DEVICE_ID;
  doc["latitude"]   = lat;
  doc["longitude"]  = lng;
  doc["speed"]      = spd;
  doc["altitude"]   = altitude;
  doc["satellites"] = satellites;

  String body;
  serializeJson(doc, body);

  Serial.println("[WiFi] Sending: " + body);

  http.beginRequest();
  http.post("/api/location");
  http.sendHeader("Host",           "diplomatic-alignment-production-ebb5.up.railway.app");
  http.sendHeader("Content-Type",   "application/json");
  http.sendHeader("Content-Length", String(body.length()));
  http.beginBody();
  http.print(body);
  http.endRequest();

  int statusCode = http.responseStatusCode();
  String responseBody = http.responseBody();
  Serial.println("[WiFi] Status: " + String(statusCode));
  Serial.println("[WiFi] Response: " + responseBody);
}
// ============================================================
//   SETUP
// ============================================================
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("=== GPS Tracker Starting ===");

  // Start GPS
  SerialGPS.begin(9600, SERIAL_8N1, GPS_RX, GPS_TX);
  Serial.println("[GPS] Serial started");

  // Try LTE first
  modemPowerOn();
  if (connectLTE()) {
    useLTE = true;
    Serial.println("[NET] Using LTE");
  } else {
    // Fall back to WiFi
    Serial.println("[NET] Falling back to WiFi...");
    if (connectWiFi()) {
      useWiFi = true;
      Serial.println("[NET] Using WiFi");
    } else {
      Serial.println("[NET] No connection available!");
    }
  }
enableGPS();
testGPS();
}
// ============================================================
//   FUNCTION: Scan WiFi and send for trilateration
// ============================================================
void sendWiFiTrilateration() {
  Serial.println("[WiFi] Starting WiFi scan for trilateration...");
  
  // Turn on WiFi just for scanning (even if we're using LTE for data)
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  delay(1000);

  Serial.println("[WiFi] Scanning for anchor networks...");
  int networksFound = WiFi.scanNetworks();
  
  if (networksFound == 0) {
    Serial.println("[WiFi] No networks found");
    return;
  }

  Serial.println("[WiFi] Found " + String(networksFound) + " networks");

  // Build JSON with all found networks
  JsonDocument doc;
  doc["device_id"] = DEVICE_ID;
  JsonArray networks = doc["networks"].to<JsonArray>();

  int matchCount = 0;
  for (int i = 0; i < networksFound; i++) {
    String ssid = WiFi.SSID(i);
    int rssi    = WiFi.RSSI(i);

    // Only include our known anchor networks
    if (ssid == "MTN_4G_E09BD1" || ssid == "Tenda_030398") {
      JsonObject network = networks.add<JsonObject>();
      network["ssid"] = ssid;
      network["rssi"] = rssi;
      matchCount++;
      Serial.println("[WiFi] Found anchor: " + ssid + " RSSI: " + String(rssi));
    }
  }

  WiFi.scanDelete();

  if (matchCount == 0) {
    Serial.println("[WiFi] No anchor networks found in scan");
    return;
  }

  String body;
  serializeJson(doc, body);
  Serial.println("[WiFi] Sending trilateration data: " + body);

  // Send via LTE if available otherwise WiFi
  if (useLTE) {
    // Use AT command HTTP to send trilateration data via LTE
    SerialAT.println("AT+HTTPTERM");
    delay(500);
    while (SerialAT.available()) SerialAT.read();

    SerialAT.println("AT+HTTPINIT");
    delay(1000);
    while (SerialAT.available()) SerialAT.read();

    SerialAT.println("AT+HTTPSSL=1");
    delay(500);
    while (SerialAT.available()) SerialAT.read();

    SerialAT.println("AT+HTTPPARA=\"URL\",\"https://diplomatic-alignment-production-ebb5.up.railway.app/api/wifi-location\"");
    delay(500);
    while (SerialAT.available()) SerialAT.read();

    SerialAT.println("AT+HTTPPARA=\"CONTENT\",\"application/json\"");
    delay(500);
    while (SerialAT.available()) SerialAT.read();

    SerialAT.println("AT+HTTPDATA=" + String(body.length()) + ",10000");
    delay(500);

    String prompt = "";
    long timeout = millis() + 5000;
    while (millis() < timeout) {
      if (SerialAT.available()) {
        prompt += (char)SerialAT.read();
        if (prompt.indexOf("DOWNLOAD") >= 0) break;
      }
    }

    SerialAT.print(body);
    delay(2000);

    SerialAT.println("AT+HTTPACTION=1");
    delay(500);

    String httpResponse = "";
    timeout = millis() + 10000;
    while (millis() < timeout) {
      if (SerialAT.available()) {
        httpResponse += (char)SerialAT.read();
        if (httpResponse.indexOf("+HTTPACTION") >= 0) break;
      }
    }
    Serial.println("[WiFi-Tri] LTE Response: " + httpResponse);

    SerialAT.println("AT+HTTPTERM");
    delay(500);
    while (SerialAT.available()) SerialAT.read();

  } else if (useWiFi) {
    // Reconnect to WiFi for sending
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 20) {
      delay(500);
      attempts++;
    }

    WiFiClientSecure client;
    client.setInsecure();
    HttpClient http(client, "diplomatic-alignment-production-ebb5.up.railway.app", 443);

    http.beginRequest();
    http.post("/api/wifi-location");
    http.sendHeader("Host",           "diplomatic-alignment-production-ebb5.up.railway.app");
    http.sendHeader("Content-Type",   "application/json");
    http.sendHeader("Content-Length", String(body.length()));
    http.beginBody();
    http.print(body);
    http.endRequest();

    int statusCode = http.responseStatusCode();
    Serial.println("[WiFi-Tri] Status: " + String(statusCode));
    Serial.println("[WiFi-Tri] Response: " + http.responseBody());
  }
}
// ============================================================
//   LOOP
// ============================================================
void loop() {
  // Request GPS info from modem via AT command
  SerialAT.println("AT+CGPSINFO");
  delay(1000);

  String response = "";
  while (SerialAT.available()) {
    response += (char)SerialAT.read();
  }

  Serial.println("[MODEM] " + response);

  if (response.indexOf("+CGPSINFO:") >= 0 && response.indexOf(",,,,") == -1) {
    
    int start = response.indexOf("+CGPSINFO:") + 10;
    String data = response.substring(start);
    data.trim();

    int idx = 0;
    String parts[10];
    for (int i = 0; i < 10; i++) {
      int comma = data.indexOf(',', idx);
      if (comma == -1) {
        parts[i] = data.substring(idx);
        break;
      }
      parts[i] = data.substring(idx, comma);
      idx = comma + 1;
    }

    // Convert NMEA to decimal degrees
    float rawLat = parts[0].toFloat();
    int latDeg   = (int)(rawLat / 100);
    float latMin = rawLat - (latDeg * 100);
    float lat    = latDeg + (latMin / 60.0);
    if (parts[1] == "S") lat = -lat;

    float rawLng = parts[2].toFloat();
    int lngDeg   = (int)(rawLng / 100);
    float lngMin = rawLng - (lngDeg * 100);
    float lng    = lngDeg + (lngMin / 60.0);
    if (parts[3] == "W") lng = -lng;

    float speed    = parts[7].toFloat();
    float altitude = parts[6].toFloat();

    Serial.printf("[GPS] Lat: %.6f, Lng: %.6f, Speed: %.1f km/h, Alt: %.1f m\n",
                  lat, lng, speed, altitude);

    // GPS fix available — send via LTE or WiFi
    if (useLTE) {
      sendViaLTE(lat, lng, speed, altitude, 0);
    } else if (useWiFi) {
      sendViaWiFi(lat, lng, speed, altitude, 0);
    }

  } else {
    // No GPS fix — fall back to WiFi trilateration
    Serial.println("[GPS] No fix — trying WiFi trilateration...");
    sendWiFiTrilateration();
  }

  delay(UPDATE_INTERVAL);
}