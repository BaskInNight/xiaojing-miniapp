# ESP32 通讯指令词典

> 版本: v1.0
> 协议: BLE (GATT) + LAN (HTTP)
> 设备: 净界同频 · JJTP 系列洗衣机

---

## 一、协议总览

| 通道 | 方向 | 数据格式 | 用途 |
|------|------|---------|------|
| BLE Write (FFF1) | 小程序 → ESP32 | UTF-8 JSON（分包≤20字节） | 控制指令 |
| BLE Notify (FFF2) | ESP32 → 小程序 | UTF-8 JSON | 状态/进度推送 |
| LAN HTTP | 双向 | JSON | 控制+查询（IP已知时） |

---

## 二、BLE 指令词典

### 2.1 小程序 → ESP32（Write 特征 FFF1）

#### `start` — 启动清洗

```json
{
  "cmd": "start",
  "steps": {
    "soak":  { "enabled": true,  "count": 1, "time": 5  },
    "wash":  { "enabled": true,  "count": 2, "time": 5  },
    "rinse": { "enabled": true,  "count": 3, "time": 5  },
    "dry":   { "enabled": false, "count": 0, "time": 20 }
  },
  "totalTime": 30
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cmd` | string | 是 | 固定值 `"start"` |
| `steps.soak.enabled` | bool | 是 | 是否启用浸泡 |
| `steps.soak.count` | int | 是 | 浸泡次数，1次=5分钟 |
| `steps.wash.enabled` | bool | 是 | 是否启用搓洗 |
| `steps.wash.count` | int | 是 | 搓洗轮数，1轮=5分钟 |
| `steps.rinse.enabled` | bool | 是 | 是否启用漂洗 |
| `steps.rinse.count` | int | 是 | 漂洗轮数（≥3），1轮=5分钟 |
| `steps.dry.enabled` | bool | 是 | 是否启用烘干 |
| `steps.dry.count` | int | 是 | 烘干轮数，1轮=20分钟 |
| `totalTime` | int | 是 | 预估总时长（分钟），用于进度推算 |

**ESP32 处理逻辑**:
```
接收 → JSON.parse → startWashSequence()
  → 遍历 4 个阶段 (SOAK/WASH/RINSE/DRY)
  → 每个阶段按 enabled + count 执行
  → 每个阶段结束后自动推进到下一阶段
  → 全部完成 → 蜂鸣提示 → 恢复空闲
```

---

#### `stop` — 停止清洗

```json
{ "cmd": "stop" }
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cmd` | string | 是 | 固定值 `"stop"` |

**ESP32 处理逻辑**:
```
接收 → JSON.parse → stopWash()
  → allStop()          // 关闭所有 GPIO
  → isRunning = false
  → sendBLEProgress(0)
  → sendBLEStatus("idle")
```

---

### 2.2 ESP32 → 小程序（Notify 特征 FFF2）

#### `info` — 设备信息（连接后主动推送）

```json
{
  "type": "info",
  "ip": "192.168.1.101",
  "mac": "AA:BB:CC:DD:EE:FF",
  "fw": "v1.0.0",
  "name": "JJTP-A01"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | string | 固定值 `"info"` |
| `ip` | string | 设备局域网 IP 地址（小程序切换 LAN 控制的关键） |
| `mac` | string | 设备 MAC 地址 |
| `fw` | string | 固件版本号 |
| `name` | string | 设备名称 |

**触发时机**: BLE Notify 启用后 800ms 自动推送。

---

#### `progress` — 清洗进度

```json
{ "type": "progress", "value": 45 }
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | string | 是 | 固定值 `"progress"` |
| `value` | int | 是 | 0~100 整数，表示完成百分比 |

**推送频率**: 每 1 秒一次。

---

#### `status` — 状态变更

```json
{ "type": "status", "value": "running" }
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | string | 固定值 `"status"` |
| `value` | string | 状态值（见下表） |

**状态枚举**:

| value | 含义 | 触发时机 |
|-------|------|---------|
| `idle` | 空闲/待机 | 开机、停止、完成恢复 |
| `running` | 运行中 | 启动清洗成功 |
| `error` | 设备故障 | 硬件异常 |
| `complete` | 清洗完成 | 所有阶段执行完毕 |

---

## 三、LAN HTTP 指令词典

### 3.1 `GET /api/info` — 查询设备信息

**请求**: 无参数

**响应**:
```json
{
  "name": "JJTP-A01",
  "status": "running",
  "progress": 45,
  "remainingTime": 15,
  "ip": "192.168.1.101",
  "mac": "AA:BB:CC:DD:EE:FF",
  "fw": "v1.0.0"
}
```

### 3.2 `POST /api/wash/start` — 启动清洗

**请求体**: 与 BLE `start` 指令格式相同

```json
{
  "steps": { ... },
  "totalTime": 30
}
```

**成功响应**:
```json
{ "success": true }
```

**失败响应**:
```json
{ "success": false, "message": "设备忙" }
```

### 3.3 `POST /api/wash/stop` — 停止清洗

**请求**: 无参数

**响应**:
```json
{ "success": true }
```

### 3.4 `GET /api/wash/progress` — 查询进度

**响应**:
```json
{
  "progress": 45,
  "remainingTime": 15,
  "status": "running"
}
```

---

## 四、固件执行阶段定义

ESP32 将清洗分为 4 个阶段按序执行：

| 阶段 | 索引 | 硬件动作 | 时长控制 |
|------|------|---------|---------|
| SOAK (浸泡) | 0 | 进水阀 ON → 等待 → 进水阀 OFF | `soak.count × soak.time` 分钟 |
| WASH (搓洗) | 1 | 电机 PWM ON → 正反转交替 | `wash.count × wash.time` 分钟 |
| RINSE (漂洗) | 2 | 进水阀 ON → 排水阀 ON → 循环 | `rinse.count × rinse.time` 分钟 |
| DRY (烘干) | 3 | 加热器 ON + 风扇 ON → 等待 | `dry.count × dry.time` 分钟 |

**执行示例**（无烘干快洗: soak×1, wash×2, rinse×3, dry×0）:

```
时间线
0:00  → SOAK 开始 → 进水阀开
0:05  → 进水阀关，等待（浸泡计时）
5:00  → SOAK 结束 → WASH 开始 → 电机正转
5:05  → 电机反转
...
15:00 → WASH 结束 → RINSE 开始 → 进水阀开
15:03 → 进水阀关 → 排水阀开
15:06 → 排水阀关 → 再次进水（第2轮）
...
30:00 → RINSE 结束 → DRY 跳过 → 清洗完成
       → 蜂鸣器响 → sendBLEStatus("complete")
```

---

## 五、BLE 分包通信规则

由于 BLE MTU 通常为 23 字节（有效载荷 20 字节），>20 字节的 JSON 需要分包：

```
小程序发送:
  stringToArrayBuffer(jsonStr)   → 转二进制
  splitBuffer(buffer, 20)        → 分包
  for each chunk:
    writeBLECharacteristicValue(chunk)
    delay(50ms)                   → 间隔 50ms

ESP32 接收:
  onWrite(value)                  → 每包触发一次
  → 内部自行粘包（需缓存直到收到完整 JSON）
  → 判断完整: JSON.parse 成功即为完整
```

**JSON 最大长度参考**:

| 指令 | 约长 | 分包数 |
|------|------|--------|
| `{"cmd":"stop"}` | 15B | 1 包 |
| `start` (quick 套餐) | ~200B | 10 包 |
| `start` (自定义/全选) | ~300B | 15 包 |

---

## 六、超时与错误处理

| 场景 | ESP32 行为 | 小程序展示 |
|------|-----------|-----------|
| BLE 断连 | 恢复广播 | 自动重连（最多5次，指数退避） |
| 指令解析失败 | 忽略，不回复 | "发送失败" toast |
| 清洗中收到 start | 忽略，不回复 | 不触发（前端已禁用） |
| WiFi 断连 | HTTP 不可用，BLE 继续推送 | 降级为 BLE 控制 |
| 硬件故障 | sendBLEStatus("error") | "设备故障" 提示 |
