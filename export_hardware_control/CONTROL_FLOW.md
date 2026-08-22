# 小程序 → 硬件 · 控制链路完整追踪

> 逐行追踪从用户操作到硬件执行的全链路代码路径。
> 格式: `文件名:行号` → 函数调用 → 数据格式

---

## 1. 扫描蓝牙设备

**用户操作**：打开"附近设备"页面 → 自动开始扫描

### 小程序端

```
devices.js:11  onLoad()
  → devices.js:16  startScan()
    → ble.js:86    scanDevices(10000)
      → wx.offBluetoothDeviceFound()           // 清旧监听器
      → wx.startBluetoothDevicesDiscovery()    // 启动 BLE 扫描

      扫描中...
      → wx.onBluetoothDeviceFound(callback)     // 发现设备
        → 过滤: device.name.startsWith("JJTP")  // 只保留命名设备
        → 去重: 按 deviceId
        → 数组: [{ deviceId, name, RSSI }]

      setTimeout 10s 后:
      → wx.stopBluetoothDevicesDiscovery()
      → resolve(foundDevices)
```

### 硬件响应

```
ESP32 BLE 广播:
  Advertising name: "JJTP-A01"
  Service UUID:     0000FFF0-... (匹配过滤)
```

### 数据流

| 步骤 | 方向 | 数据 |
|------|------|------|
| 广播 | 设备 → 小程序 | `{ deviceId: "xx:xx", name: "JJTP-A01", RSSI: -65 }` |
| 返回 | BLE模块 → 页面 | `[{ deviceId, name: "JJTP-A01", RSSI: -65 }, ...]` |

---

## 2. 连接设备并获取 IP

**用户操作**：点击设备列表中的某台设备

### 小程序端

```
devices.js:52  selectDevice(e)
  → 取出 device.deviceId
  → ble.js:100  connectDevice(deviceId)
    → wx.createBLEConnection(deviceId)         // BLE 连接
    
    连接成功后:
    → setTimeout 500ms                         // 等待连接稳定
    → ble.js:142  getServices(deviceId)
      → wx.getBLEDeviceServices()
        → 查找 SERVICE_UUID (FFF0)
        → wx.getBLEDeviceCharacteristics()
          → 查找 WRITE_CHAR_UUID (FFF1) → writeChar
          → 查找 NOTIFY_CHAR_UUID (FFF2) → notifyChar
          → wx.notifyBLECharacteristicValueChange(state: true)
        → resolve({ deviceId, serviceId, writeCharId, notifyCharId, properties })

    → wx.getBLEDeviceRSSI()                    // 获取信号强度
    → info.RSSI = rssiRes.RSSI

  → .then(info => ...)
    → app.globalData.bleConnected = true
    → devices.js:74-83  prevPage.setData(...)   // 把设备信息传回 wash 页面
      → bleConnected, bleDeviceId, bleDeviceName
      → bleServiceId, bleWriteCharId, bleNotifyCharId
      → bleRSSI: (info.RSSI || device.RSSI) + 'dBm'

    → wx.navigateBack()                        // 返回 wash 页面
```

### 硬件响应（关键：获取 IP）

```
ESP32:
  onConnect():
    → 记录连接状态
    → delay(800ms) → 等 Notify CCCD 写好
    → sendDeviceInfo()
      → BLE Notify: {"type":"info","ip":"192.168.1.101","mac":"AA:BB:CC:DD:EE:FF","fw":"v1.0.0","name":"JJTP-A01"}
```

### 小程序处理硬件推送的 IP

```
wash.js:110  ble.onDataReceived((data) => {
    → JSON.parse(data)
    → msg.type === 'info'  ← 收到设备信息
      → 从中提取 msg.ip
      → 保存到 app.globalData.currentDevice.ip
      → 后续 HTTP API 全部通过此 IP 发送
  })
```

### BLE Notify 回调注册

```
wash.js:97  initBLEListener()
  → wx.offBLECharacteristicValueChange()       // 清旧监听
  → wx.onBLECharacteristicValueChange(callback) // 注册新回调
    → 收到 {"type":"progress","value":45}        → 更新进度
    → 收到 {"type":"status","value":"running"}   → 更新状态
    → 收到 {"type":"info","ip":"192.168.1.101"}  → 保存 IP
```

### 数据流

| 步骤 | 方向 | 数据 |
|------|------|------|
| BLE 连接请求 | 小程序 → 设备 | `createBLEConnection(deviceId)` |
| 获取服务 | 小程序 → 设备 | `getBLEDeviceServices()` → 返回 FFF0 |
| 获取特征值 | 小程序 → 设备 | `getBLEDeviceCharacteristics()` → 返回 FFF1, FFF2 |
| 启用通知 | 小程序 → 设备 | `notifyBLECharacteristicValueChange(FFF2, true)` |
| **推送设备信息** | **设备 → 小程序** | `{"type":"info","ip":"192.168.1.101","mac":"...","name":"JJTP-A01"}` |
| 获取信号强度 | 小程序 → 设备 | `getBLEDeviceRSSI()` → -65dBm |

---

## 3. 选择套餐与自定义步骤

**用户操作**：在 wash 页面选择"无烘干快洗"或"烘干清洗"套餐，或自定义步骤

### 小程序端（纯前端，不涉及硬件）

```
wash.js:178  selectPackage(e)
  → 选择 "quick": basePrice=1, dry 禁用
  → 选择 "dry":   basePrice=2, dry 启用
  → 调用 calculateTotal()

wash.js:258  calculateTotal()
  → 遍历 steps → 累加每个 enabled 步骤的 (count × time)
  → totalPrice = packageBasePrice + addonPrice
  → setData({ totalTime, totalPrice, finalPrice })
```

### 下发给硬件的参数结构

```
{
  steps: {
    soak:  { enabled: true,  count: 1, time: 5  },
    wash:  { enabled: true,  count: 2, time: 5  },
    rinse: { enabled: true,  count: 3, time: 5  },
    dry:   { enabled: false, count: 0, time: 20 }
  },
  totalTime: 30
}
```

---

## 4. 启动清洗

**用户操作**：点击"提交订单并启动设备" → 确认支付

### 小程序端

```
wash.js:294  submitOrder()
  → 检查 bleConnected，未连接则提示
  → 组装 orderData: { deviceId, steps, totalTime, ... }
  → 不是预约 → 显示确认对话框
  → 用户点击"确认支付"
  → wash.js:433  startWashViaBLE(orderData)

wash.js:433  startWashViaBLE(orderData)
  → wx.showLoading('启动中...')

  → ble.js:298  buildWashCommand(orderData)
    → return JSON.stringify({
        cmd: 'start',
        steps: orderData.steps,
        totalTime: orderData.totalTime
      })

  → ble.js:202  sendCommand(deviceId, serviceId, charId, commandJSON)
    → stringToArrayBuffer(jsonStr)
    → splitBuffer(buffer, 20)         // 分包: 每包20字节
    → 循环分包发送:
        wx.writeBLECharacteristicValue(chunk[0])
        → setTimeout(50ms) → 写下一包

  .then(() => {
    → 本地设为 isWashing=true
    → 启动本地进度模拟
    → 调用 saveOrder() 云函数保存订单
  })
```

### 硬件收到指令 → 执行清洗

```
ESP32 收到 BLE Write:
  onWrite(characteristic)
    → value = 收到的 JSON 字符串（自动粘包）

  → 解析: {"cmd":"start","steps":{...},"totalTime":30}

  → startWashSequence(doc)
    → 保存 steps 配置到全局
    → isRunning = true
    → sendBLEStatus("running")
    → sendBLEProgress(0)
    → advanceStage()
      → 检查 stage 0 (SOAK)
        → soak.enabled=true → 执行 SOAK
        → RELAY_INFLOW = HIGH   // 进水阀开
        → delay(5000)           // 进水5秒
        → RELAY_INFLOW = LOW    // 进水阀关

      → stageElapsed 达到 soak.time*60 秒后
        → currentRepeat++
        → advanceStage() → WASH
        → MOTOR_PWM = HIGH       // 电机启动
        → MOTOR_DIR 交替 HIGH/LOW // 正反转

      → 重复... rinse → dry...

      → 所有阶段完成
        → onWashComplete()
        → allStop()              // 关闭所有输出
        → beep(3,200)            // 蜂鸣提示
        → sendBLEProgress(100)
        → sendBLEStatus("complete")
```

---

## 5. 监控清洗进度

**用户操作**：查看清洗进度条和剩余时间

### 方案 A：BLE Notify（实时推送，默认路径）

```
硬件每秒推送:
  sendBLEProgress(当前进度%)
  → BLE Notify: {"type":"progress","value":45}

小程序接收:
  wash.js:110  onBLECharacteristicValueChange(callback)
    → JSON.parse(data)
    → msg.type === 'progress'
    → setData({ progress: msg.value, useRealProgress: true })
    → 如果 value >= 100 → onWashComplete()

  UI 绑定:
    wash.wxml:281  进度条: style="width: {{progress}}%;"
    wash.wxml:283  百分比: {{progress}}%
    wash.wxml:284  剩余时间: {{remainingTime}} 分钟
```

### 方案 B：本地模拟（BLE 断开时降级）

```
wash.js:471  startProgressSimulation(totalMinutes)
  → setInterval(每秒):
    → if (useRealProgress) return     // BLE 数据优先
    → progress = elapsed / totalSeconds * 100
    → setData({ progress, remainingTime })
```

### 方案 C：LAN HTTP 轮询（WiFi 控制时使用）

```
api.js:56  getProgress()
  → GET http://192.168.1.101/api/wash/progress
    → 返回: {"progress":45,"remainingTime":15,"status":"running"}
```

### 数据流对比

| 路径 | 实时性 | 依赖 | 数据格式 |
|------|--------|------|----------|
| BLE Notify | ~1s | BLE 连接 | `{"type":"progress","value":45}` |
| 本地模拟 | ~1s | 无 | 前端本地计算 |
| HTTP GET | 轮询间隔 | WiFi 局域网 | `{"progress":45,"remainingTime":15}` |

---

## 6. 停止清洗

**用户操作**：点击"停止清洗" → 确认

### 小程序端

```
wash.js:501  stopWash()
  → 显示确认对话框
  → 用户确认
  → ble.js:299  buildStopCommand()
    → return JSON.stringify({ cmd: 'stop' })
  → ble.js:202  sendCommand(deviceId, serviceId, charId, stopCmd)
    → writeBLECharacteristicValue({cmd:"stop"})
  .then(() => {
    → clearProgressTimer()
    → setData({ isWashing: false, progress: 0 })
  })
```

### 硬件响应

```
ESP32 onWrite:
  → 解析: {"cmd":"stop"}
  → stopWash()
    → isRunning = false
    → allStop()           // 关闭进水阀、排水阀、电机、加热器、风扇
    → currentState = IDLE
    → sendBLEProgress(0)
    → sendBLEStatus("idle")
```

---

## 7. LAN HTTP 控制（替代 BLE）

**场景**：已通过 BLE 获得设备 IP，后续使用 WiFi 局域网控制

### 获取设备 IP（通过 BLE）

```
小程序 ← BLE Notify: {"type":"info","ip":"192.168.1.101"}
小程序 → api.js: 保存到 app.globalData.currentDevice.ip
```

### 后续所有请求走 HTTP

```
api.js:47  startWash(params)
  → POST http://192.168.1.101/api/wash/start
  → Body: {"steps":{...},"totalTime":30}

api.js:51  stopWash()
  → POST http://192.168.1.101/api/wash/stop

api.js:55  getProgress()
  → GET  http://192.168.1.101/api/wash/progress
  → 返回: {"progress":45,"remainingTime":15,"status":"running"}

api.js:32  getDeviceInfo(ip)
  → GET  http://192.168.1.101/api/info
  → 返回: {"name":"JJTP-A01","status":"running","progress":45,...}
```

### 硬件 HTTP Server 处理

```
ESP32 WebServer:
  handleWashStart()
    → 解析 JSON body
    → startWashSequence(doc)
    → 返回 {"success":true}

  handleWashStop()
    → stopWash()
    → 返回 {"success":true}

  handleWashProgress()
    → 读取 isRunning, progressPercent, remainingMinutes
    → 返回 {"progress":45,"remainingTime":15,"status":"running"}

  handleGetInfo()
    → 返回设备完整信息
```

---

## 8. 预约（不涉及硬件）

**用户操作**：开启预约开关 → 选择日期时间 → 确认预约

```
只涉及云函数，不涉及硬件通信
wash.js:371  createBooking(orderData)
  → wx.cloud.callFunction('createOrder')
  → wx.setStorageSync('washBookings', ...)
```

---

## 全链路图

```
小程序 UI                   通信层               硬件 ESP32
══════════════            ════════            ════════════

首页 → 附近设备 ──BLE scan──→  BLE广播(JJTP-*)
                                  │
点击设备 ──BLE connect─────────→  onConnect()
                                  │
          ──getServices(FFF0)──→  返回服务
          ──getChars(FFF1/FFF2)→  返回特征值
          ──notify ON──────────→  启用通知
                                  │
                              ←── Notify: {"type":"info","ip":"192.168.1.101"}
                                  │
 ──── 获得 IP，后续可切换 LAN ──→  HTTP API 服务
                                  │
 选套餐 ──（纯前端计算steps）──
                                  │
 启动清洗 ──BLE write: {cmd:"start"} ──→  startWashSequence()
                                  │       ├── 浸泡(进水阀)
                                  │       ├── 搓洗(电机)
                                  │       ├── 漂洗(排水阀)
                                  │       └── 烘干(加热器+风扇)
                                  │
进度条   ←── BLE Notify: {type:"progress"} ── sendBLEProgress()
          ←── 或 LAN GET /api/wash/progress
                                  │
 停止   ──BLE write: {cmd:"stop"} ────→  stopWash() → allStop()
```
