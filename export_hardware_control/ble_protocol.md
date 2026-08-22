# BLE 蓝牙协议规范

## 1. 广播（Advertising）

| 字段 | 值 |
|------|-----|
| 广播名称 | `JJTP-{设备ID}` (如 `JJTP-A01`) |
| 广播间隔 | 200ms |
| 厂商数据 | 可选，可包含设备状态位 |

## 2. GATT 服务

### 服务定义

| 属性 | UUID |
|------|------|
| **Service** | `0000FFF0-0000-1000-8000-00805F9B34FB` |
| Write Characteristic | `0000FFF1-0000-1000-8000-00805F9B34FB` |
| Notify Characteristic | `0000FFF2-0000-1000-8000-00805F9B34FB` |

### Write 特征（小程序 → 设备）

- **UUID**: `0000FFF1-0000-1000-8000-00805F9B34FB`
- **属性**: Write, Write Without Response
- **最大包长**: 20 字节（MTU=23）
- **编码**: UTF-8 JSON（分包发送）

### Notify 特征（设备 → 小程序）

- **UUID**: `0000FFF2-0000-1000-8000-00805F9B34FB`
- **属性**: Notify
- **编码**: UTF-8 JSON

## 3. 小程序 → 设备指令

### 启动清洗

```json
{
  "cmd": "start",
  "steps": {
    "soak": { "enabled": true,  "count": 1, "time": 5  },
    "wash": { "enabled": true,  "count": 2, "time": 5  },
    "rinse":{ "enabled": true,  "count": 3, "time": 5  },
    "dry":  { "enabled": false, "count": 0, "time": 20 }
  },
  "totalTime": 30
}
```

> 分包规则：每包 20 字节，间隔 50ms 发送下一包。
> 设备收到完整 JSON 后开始执行。

### 停止清洗

```json
{ "cmd": "stop" }
```

## 4. 设备 → 小程序通知

### 连接后立即发送 - 设备信息

```json
{
  "type": "info",
  "ip": "192.168.1.101",
  "mac": "AA:BB:CC:DD:EE:FF",
  "fw": "v1.0.0",
  "name": "JJTP-A01"
}
```

### 清洗进度推送

```json
{
  "type": "progress",
  "value": 45
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | string | 是 | 固定为 `progress` |
| `value` | int | 是 | 0~100 整数，表示清洗完成百分比 |

> 建议设备端每秒推送一次进度。

### 状态变更推送

```json
{
  "type": "status",
  "value": "running"
}
```

`value` 枚举：

| 值 | 含义 |
|----|------|
| `idle` | 空闲/待机 |
| `running` | 运行中 |
| `error` | 设备故障 |
| `complete` | 清洗完成 |

## 5. BLE 通信流程

```
小程序                             硬件设备
  │                                    │
  ├── 扫描 ──────────────────────►     │
  │     (寻找JJTP前缀的设备)           │
  │                                    │
  │◄──── 广播响应 ──────────────────   │
  │     (设备名:JJTP-A01)             │
  │                                    │
  ├── createBLEConnection ───────►     │
  │                                    │
  │◄──── 连接成功 ───────────────────  │
  │                                    │
  ├── getBLEDeviceServices ──────►     │
  │◄──── 返回FFF0服务 ─────────────── │
  │                                    │
  ├── getBLEDeviceCharacteristics ►   │
  │◄──── 返回FFF1/FFF2 ────────────── │
  │                                    │
  ├── notifyBLECharacteristicValue ►  │
  │     (启用FFF2通知)                 │
  │                                    │
  │◄──── Notify: 设备信息(含IP) ───── │
  │     {"type":"info","ip":"..."}     │
  │                                    │
  │  ─── 后续切换 LAN HTTP 控制 ──►   │
  │     也可以通过BLE发送指令          │
  │                                    │
  ├── writeBLE: {"cmd":"start",...} ►  │
  │                                    │
  │◄──── Notify: 进度 ──────────────  │
  │     {"type":"progress","value":50} │
  │                                    │
  │◄──── Notify: 完成 ─────────────── │
  │     {"type":"progress","value":100}│
  │             或                     │
  │     {"type":"status","value":"done"}│
```

## 6. 注意事项

1. BLE 分包发送：由于 MTU=23（有效载荷 20 字节），>20 字节的 JSON 必须分包
2. 分包间隔 50ms，避免设备处理不过来
3. 设备应在 Notify 启用后 500ms 内推送设备信息
4. 进度推送频率建议 1 次/秒
5. 如 WiFi 断连，设备可通过 BLE 通知告知小程序
