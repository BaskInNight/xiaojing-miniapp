/**
 * ============================================================
 *  净界同频 · 洗衣机 ESP32 固件参考实现
 *  实现 BLE 控制 + LAN HTTP API 双模通信
 * ============================================================
 *
 *  硬件: ESP32 (推荐 ESP32-WROOM-32)
 *  功能:
 *    - BLE 广播 "JJTP-{name}"，提供 FFF0 服务
 *    - 接收 BLE Write 指令（启动/停止）
 *    - BLE Notify 实时推送进度
 *    - HTTP Server 提供 RESTful API
 *    - WiFi 自动连接
 *
 *  引脚配置（根据实际硬件修改）:
 *    RELAY_INFLOW  = 26   // 进水阀
 *    RELAY_DRAIN   = 27   // 排水阀
 *    MOTOR_PWM     = 14   // 电机 PWM
 *    MOTOR_DIR     = 12   // 电机方向
 *    HEATER        = 13   // 加热器（烘干）
 *    FAN           = 15   // 风扇（烘干）
 *    BUZZER        = 16   // 蜂鸣器
 *    DOOR_SENSOR   = 17   // 门锁传感器
 *
 *  依赖库:
 *    - WiFi.h        (ESP32 内置)
 *    - WebServer.h   (ESP32 内置)
 *    - BLEDevice.h   (ESP32 内置)
 *    - ArduinoJson   (v6, 需安装)
 * ============================================================
 */

#include <WiFi.h>
#include <WebServer.h>
#include <BLEDevice.h>
#include <BLEUtils.h>
#include <BLEServer.h>
#include <BLE2902.h>
#include <ArduinoJson.h>

// ====================== 配置区域 ============================

// WiFi 配置（生产环境建议从 BLE 配网）
const char* WIFI_SSID = "YourWiFiSSID";
const char* WIFI_PASS = "YourWiFiPassword";

// 设备标识
const String DEVICE_NAME = "JJTP-A01";
const String FW_VERSION = "v1.0.0";

// BLE UUID（必须与小程序端一致）
#define SERVICE_UUID        "0000FFF0-0000-1000-8000-00805F9B34FB"
#define CHARACTERISTIC_UUID_WRITE "0000FFF1-0000-1000-8000-00805F9B34FB"
#define CHARACTERISTIC_UUID_NOTIFY "0000FFF2-0000-1000-8000-00805F9B34FB"

// 引脚定义
#define RELAY_INFLOW  26
#define RELAY_DRAIN   27
#define MOTOR_PWM     14
#define MOTOR_DIR     12
#define HEATER        13
#define FAN           15
#define BUZZER        16
#define DOOR_SENSOR   17

// HTTP 服务端口
WebServer server(80);

// ====================== 全局状态 ============================

// BLE 相关
BLECharacteristic *pNotifyCharacteristic = nullptr;
bool bleConnected = false;

// 清洗状态
enum WashState { IDLE, SOAK, WASH, RINSE, DRY, COMPLETE, ERROR_STATE };
WashState currentState = IDLE;
bool isRunning = false;
int progressPercent = 0;
int remainingMinutes = 0;
int totalMinutes = 0;

// 步骤配置（由小程序下发）
struct StepConfig {
  bool enabled;
  int count;
  int time;  // 分钟/次
};
struct {
  StepConfig soak;
  StepConfig wash;
  StepConfig rinse;
  StepConfig dry;
} stepsConfig;

// 执行跟踪
int currentStage = 0;        // 当前执行到第几个 enabled 的步骤
int currentRepeat = 0;       // 当前步骤的第几次
int stageElapsed = 0;        // 当前阶段已过秒数
unsigned long lastTick = 0;  // 上次进度更新时间

// ====================== 函数声明 ============================

void initWiFi();
void initBLE();
void initHardware();
void startHTTP();
void startWashSequence(JsonDocument &doc);
void stopWash();
void updateProgress();
void sendBLEProgress(int value);
void sendBLEStatus(const char* status);
void executeStage(WashState stage);
void allStop();
void handleGetInfo();
void handleWashStart();
void handleWashStop();
void handleWashProgress();

// ====================== HTTP 路由处理 =======================

/** GET /api/info */
void handleGetInfo() {
  StaticJsonDocument<256> doc;
  doc["name"] = DEVICE_NAME;
  doc["status"] = isRunning ? "running" : "idle";
  doc["progress"] = progressPercent;
  doc["remainingTime"] = remainingMinutes;
  doc["ip"] = WiFi.localIP().toString();
  doc["fw"] = FW_VERSION;

  String response;
  serializeJson(doc, response);
  server.send(200, "application/json", response);
}

/** POST /api/wash/start */
void handleWashStart() {
  if (isRunning) {
    server.send(409, "application/json", "{\"success\":false,\"message\":\"设备忙\"}");
    return;
  }

  String body = server.arg("plain");
  StaticJsonDocument<512> doc;
  DeserializationError error = deserializeJson(doc, body);

  if (error) {
    server.send(400, "application/json", "{\"success\":false,\"message\":\"参数错误\"}");
    return;
  }

  startWashSequence(doc);
  server.send(200, "application/json", "{\"success\":true}");
}

/** POST /api/wash/stop */
void handleWashStop() {
  if (!isRunning) {
    server.send(200, "application/json", "{\"success\":true}");
    return;
  }
  stopWash();
  server.send(200, "application/json", "{\"success\":true}");
}

/** GET /api/wash/progress */
void handleWashProgress() {
  StaticJsonDocument<128> doc;
  doc["progress"] = progressPercent;
  doc["remainingTime"] = remainingMinutes;
  doc["status"] = isRunning ? "running" : "idle";
  String response;
  serializeJson(doc, response);
  server.send(200, "application/json", response);
}

// ====================== BLE 回调 ============================

class MyServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* pServer) {
    bleConnected = true;
    Serial.println("[BLE] 设备已连接");
  }

  void onDisconnect(BLEServer* pServer) {
    bleConnected = false;
    Serial.println("[BLE] 设备已断开");
    // 重开广播
    pServer->getAdvertising()->start();
  }
};

class MyCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *pCharacteristic) {
    String value = pCharacteristic->getValue();
    if (value.length() == 0) return;

    Serial.println("[BLE] 收到指令: " + value);

    StaticJsonDocument<512> doc;
    DeserializationError error = deserializeJson(doc, value);

    if (error) {
      Serial.println("[BLE] JSON 解析失败");
      return;
    }

    const char* cmd = doc["cmd"];
    if (!cmd) return;

    if (strcmp(cmd, "start") == 0) {
      if (!isRunning) {
        startWashSequence(doc);
      }
    } else if (strcmp(cmd, "stop") == 0) {
      stopWash();
    }
  }
};

// ====================== BLE & WiFi 初始化 ===================

void initWiFi() {
  Serial.print("[WiFi] 连接 ");
  Serial.print(WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  int retry = 0;
  while (WiFi.status() != WL_CONNECTED && retry < 40) {
    delay(500);
    Serial.print(".");
    retry++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[WiFi] 连接成功");
    Serial.print("[WiFi] IP 地址: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\n[WiFi] 连接失败，将继续 BLE 模式");
  }
}

void initBLE() {
  BLEDevice::init(("JJTP-" + DEVICE_NAME).c_str());
  BLEServer *pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());

  BLEService *pService = pServer->createService(SERVICE_UUID);

  // Write 特征
  BLECharacteristic *pWriteChar = pService->createCharacteristic(
    CHARACTERISTIC_UUID_WRITE,
    BLECharacteristic::PROPERTY_WRITE |
    BLECharacteristic::PROPERTY_WRITE_NR
  );
  pWriteChar->setCallbacks(new MyCallbacks());

  // Notify 特征
  pNotifyCharacteristic = pService->createCharacteristic(
    CHARACTERISTIC_UUID_NOTIFY,
    BLECharacteristic::PROPERTY_NOTIFY
  );
  pNotifyCharacteristic->addDescriptor(new BLE2902());

  pService->start();

  // 广播
  BLEAdvertising *pAdvertising = pServer->getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x06);
  pAdvertising->setMinPreferred(0x12);
  pAdvertising->start();

  Serial.println("[BLE] 服务已启动，等待连接...");
}

// ====================== 硬件控制 ============================

void initHardware() {
  pinMode(RELAY_INFLOW, OUTPUT);
  pinMode(RELAY_DRAIN, OUTPUT);
  pinMode(MOTOR_PWM, OUTPUT);
  pinMode(MOTOR_DIR, OUTPUT);
  pinMode(HEATER, OUTPUT);
  pinMode(FAN, OUTPUT);
  pinMode(BUZZER, OUTPUT);
  pinMode(DOOR_SENSOR, INPUT_PULLUP);

  allStop();

  Serial.println("[硬件] 初始化完成");
}

void allStop() {
  digitalWrite(RELAY_INFLOW, LOW);
  digitalWrite(RELAY_DRAIN, LOW);
  digitalWrite(MOTOR_PWM, LOW);
  digitalWrite(MOTOR_DIR, LOW);
  digitalWrite(HEATER, LOW);
  digitalWrite(FAN, LOW);
  digitalWrite(BUZZER, LOW);
}

void beep(int times, int duration) {
  for (int i = 0; i < times; i++) {
    digitalWrite(BUZZER, HIGH);
    delay(duration);
    digitalWrite(BUZZER, LOW);
    if (i < times - 1) delay(duration);
  }
}

// ====================== 清洗控制 ============================

/**
 * 解析小程序下发的步骤配置，启动清洗
 */
void startWashSequence(JsonDocument &doc) {
  stepsConfig.soak  = { doc["steps"]["soak"]["enabled"],  doc["steps"]["soak"]["count"],  doc["steps"]["soak"]["time"] };
  stepsConfig.wash  = { doc["steps"]["wash"]["enabled"],  doc["steps"]["wash"]["count"],  doc["steps"]["wash"]["time"] };
  stepsConfig.rinse = { doc["steps"]["rinse"]["enabled"], doc["steps"]["rinse"]["count"], doc["steps"]["rinse"]["time"] };
  stepsConfig.dry   = { doc["steps"]["dry"]["enabled"],   doc["steps"]["dry"]["count"],   doc["steps"]["dry"]["time"] };

  totalMinutes = doc["totalTime"] | 30;
  remainingMinutes = totalMinutes;
  progressPercent = 0;
  currentStage = 0;
  currentRepeat = 0;
  stageElapsed = 0;
  isRunning = true;
  currentState = IDLE;

  lastTick = millis();
  Serial.println("[清洗] 启动");
  sendBLEStatus("running");
  sendBLEProgress(0);

  // 从第一阶段开始
  advanceStage();
}

/**
 * 推进到下一个有效阶段
 */
void advanceStage() {
  if (!isRunning) return;

  int stageIndex = 0;
  WashState stages[] = { SOAK, WASH, RINSE, DRY };
  StepConfig configs[] = { stepsConfig.soak, stepsConfig.wash, stepsConfig.rinse, stepsConfig.dry };

  // 找到当前应该执行的阶段
  while (currentStage < 4) {
    WashState s = stages[currentStage];
    StepConfig &cfg = configs[currentStage];

    if (cfg.enabled && cfg.count > 0) {
      if (currentRepeat < cfg.count) {
        currentState = s;
        stageElapsed = 0;
        executeStage(s);
        Serial.printf("[清洗] 阶段: %d, 第 %d/%d 次\n", currentStage, currentRepeat + 1, cfg.count);
        return;
      } else {
        currentRepeat = 0;
        currentStage++;
      }
    } else {
      currentStage++;
    }
  }

  // 所有阶段完成
  onWashComplete();
}

/**
 * 根据阶段执行硬件动作
 */
void executeStage(WashState stage) {
  switch (stage) {
    case SOAK:
      digitalWrite(RELAY_INFLOW, HIGH);   // 进水
      delay(5000);                         // 进水5秒（演示）
      digitalWrite(RELAY_INFLOW, LOW);
      break;

    case WASH:
      digitalWrite(MOTOR_DIR, HIGH);
      // 正转3秒，反转3秒（循环）
      break;

    case RINSE:
      digitalWrite(RELAY_INFLOW, HIGH);
      delay(3000);
      digitalWrite(RELAY_INFLOW, LOW);
      digitalWrite(RELAY_DRAIN, HIGH);
      delay(3000);
      digitalWrite(RELAY_DRAIN, LOW);
      break;

    case DRY:
      digitalWrite(HEATER, HIGH);
      digitalWrite(FAN, HIGH);
      break;

    default:
      break;
  }
}

/**
 * 每 1 秒调用，更新进度和阶段
 */
void updateProgress() {
  if (!isRunning) return;

  stageElapsed++;
  int totalSeconds = totalMinutes * 60;
  int elapsedSeconds = (millis() - lastTick) / 1000;

  // 更新进度
  progressPercent = min(99, (int)((float)elapsedSeconds / totalSeconds * 100));
  remainingMinutes = max(0, totalMinutes - (int)(elapsedSeconds / 60));

  // 计算当前阶段的完成时间（根据 steps 配置）
  StepConfig configs[] = { stepsConfig.soak, stepsConfig.wash, stepsConfig.rinse, stepsConfig.dry };
  if (currentStage < 4) {
    StepConfig &cfg = configs[currentStage];
    int stageDuration = cfg.time * 60; // 秒
    if (stageElapsed >= stageDuration) {
      currentRepeat++;
      advanceStage();
    }
  }

  // BLE 推送
  sendBLEProgress(progressPercent);

  // 阶段完成检测
  if (progressPercent >= 100) {
    onWashComplete();
  }
}

/**
 * 清洗完成
 */
void onWashComplete() {
  isRunning = false;
  progressPercent = 100;
  remainingMinutes = 0;
  currentState = COMPLETE;

  allStop();
  beep(3, 200);

  Serial.println("[清洗] 完成");
  sendBLEProgress(100);
  sendBLEStatus("complete");

  // 5分钟后自动恢复 idle
  delay(300000);
  if (!isRunning) {
    currentState = IDLE;
    sendBLEStatus("idle");
  }
}

/**
 * 停止清洗
 */
void stopWash() {
  isRunning = false;
  currentState = IDLE;
  progressPercent = 0;
  remainingMinutes = 0;

  allStop();

  Serial.println("[清洗] 已停止");
  sendBLEProgress(0);
  sendBLEStatus("idle");
}

// ====================== BLE 发送 ============================

void sendBLEProgress(int value) {
  if (!bleConnected || !pNotifyCharacteristic) return;

  StaticJsonDocument<96> doc;
  doc["type"] = "progress";
  doc["value"] = value;
  String json;
  serializeJson(doc, json);

  pNotifyCharacteristic->setValue(json.c_str());
  pNotifyCharacteristic->notify();
}

void sendBLEStatus(const char* status) {
  if (!bleConnected || !pNotifyCharacteristic) return;

  StaticJsonDocument<96> doc;
  doc["type"] = "status";
  doc["value"] = status;
  String json;
  serializeJson(doc, json);

  pNotifyCharacteristic->setValue(json.c_str());
  pNotifyCharacteristic->notify();
}

/**
 * 发送设备信息（小程序连接后获取IP的关键）
 */
void sendDeviceInfo() {
  if (!bleConnected || !pNotifyCharacteristic) return;

  StaticJsonDocument<256> doc;
  doc["type"] = "info";
  doc["ip"] = WiFi.localIP().toString();
  doc["mac"] = WiFi.macAddress();
  doc["fw"] = FW_VERSION;
  doc["name"] = DEVICE_NAME;

  String json;
  serializeJson(doc, json);

  pNotifyCharacteristic->setValue(json.c_str());
  pNotifyCharacteristic->notify();

  Serial.println("[BLE] 已推送设备信息: " + json);
}

// ====================== HTTP 路由注册 =======================

void startHTTP() {
  server.on("/api/info", HTTP_GET, handleGetInfo);
  server.on("/api/wash/start", HTTP_POST, handleWashStart);
  server.on("/api/wash/stop", HTTP_POST, handleWashStop);
  server.on("/api/wash/progress", HTTP_GET, handleWashProgress);
  server.begin();
  Serial.println("[HTTP] API 服务已启动");
}

// ====================== 主程序 ==============================

void setup() {
  Serial.begin(115200);
  Serial.println("\n\n===== 净界同频 · 洗衣机固件启动 =====");

  initHardware();
  initWiFi();
  initBLE();
  startHTTP();

  Serial.println("\n===== 启动完成 =====");
  Serial.println("设备名: " + DEVICE_NAME);
  Serial.print("BLE 名: JJTP-"); Serial.println(DEVICE_NAME);
  Serial.print("HTTP: http://"); Serial.print(WiFi.localIP()); Serial.println("/api/info");

  // 蜂鸣器提示启动完成
  beep(1, 100);
}

void loop() {
  // 处理 HTTP 请求
  server.handleClient();

  // 定时更新清洗进度（1秒间隔）
  static unsigned long lastProgressUpdate = 0;
  if (millis() - lastProgressUpdate >= 1000) {
    lastProgressUpdate = millis();
    updateProgress();
  }

  // BLE 连接上后延迟推送设备信息（等待 Notify 启用）
  static bool infoSent = false;
  if (bleConnected && !infoSent && pNotifyCharacteristic) {
    delay(800); // 等 Notify CCCD 配置好
    sendDeviceInfo();
    infoSent = true;
  }
  if (!bleConnected) {
    infoSent = false;
  }

  // 检查 WiFi 状态，断线重连
  static unsigned long lastWiFiCheck = 0;
  if (millis() - lastWiFiCheck >= 30000) {
    lastWiFiCheck = millis();
    if (WiFi.status() != WL_CONNECTED) {
      Serial.println("[WiFi] 断线，尝试重连...");
      WiFi.reconnect();
    }
  }
}
