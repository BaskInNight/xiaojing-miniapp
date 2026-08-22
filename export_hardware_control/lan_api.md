# LAN HTTP API 规范

## 基础信息

| 项 | 值 |
|----|-----|
| 传输协议 | HTTP/1.1 |
| 默认端口 | 80 |
| 编码 | UTF-8 |
| 请求体格式 | `application/json` |
| 响应体格式 | `application/json` |
| 超时 | 3s（信息查询）/ 10s（控制指令） |

## 端点列表

### `GET /api/info` — 获取设备信息

查询设备基本状态。

**请求**：无参数

**成功响应**：
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

**字段说明**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 设备名称 |
| `status` | string | 是 | `idle`(空闲) / `running`(运行中) / `error`(故障) |
| `progress` | int | 是 | 0~100 完成百分比 |
| `remainingTime` | int | 是 | 剩余分钟数 |
| `ip` | string | 是 | 设备局域网 IP |
| `mac` | string | 否 | MAC 地址 |
| `fw` | string | 否 | 固件版本 |

---

### `POST /api/wash/start` — 启动清洗

**请求体**：
```json
{
  "steps": {
    "soak":  { "enabled": true,  "count": 1, "time": 5 },
    "wash":  { "enabled": true,  "count": 2, "time": 5 },
    "rinse": { "enabled": true,  "count": 3, "time": 5 },
    "dry":   { "enabled": false, "count": 0, "time": 20 }
  },
  "totalTime": 30
}
```

**字段说明**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `steps.soak` | object | 浸泡：每次 5 分钟，免费 |
| `steps.wash` | object | 搓洗：每次 5 分钟，免费 |
| `steps.rinse` | object | 漂洗：每次 5 分钟，免费，最少 3 轮 |
| `steps.dry` | object | 烘干：每次 20 分钟，¥1/轮 |
| `totalTime` | int | 预估总时长（分钟），固件可据此推算进度 |

**成功响应**：
```json
{ "success": true }
```

**失败响应**：
```json
{ "success": false, "message": "设备忙" }
```

**错误码**：

| HTTP状态码 | message | 说明 |
|-----------|---------|------|
| 200 | — | 成功 |
| 400 | 参数错误 | 请求体格式不对 |
| 409 | 设备忙 | 设备正在运行中 |
| 500 | 内部错误 | 硬件异常 |

---

### `POST /api/wash/stop` — 停止清洗

**请求**：无参数

**成功响应**：
```json
{ "success": true }
```

---

### `GET /api/wash/progress` — 查询进度

**请求**：无参数

**成功响应**：
```json
{
  "progress": 45,
  "remainingTime": 15,
  "status": "running"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `progress` | int (0~100) | 完成百分比 |
| `remainingTime` | int | 剩余分钟数 |
| `status` | string | 设备状态 |

## 固件端实现流程

```
收到 POST /api/wash/start
  │
  ├── 解析 steps JSON
  ├── 校验参数
  ├── 返回 {success:true}
  ├── 开始执行清洗流程
  │     ├── stage 1: 浸泡 (soak)   - 开进水阀 → 浸泡计时
  │     ├── stage 2: 搓洗 (wash)   - 启动电机 → 正反转
  │     ├── stage 3: 漂洗 (rinse)  - 进水 → 排水 → 脱水
  │     └── stage 4: 烘干 (dry)    - 启动加热 → 吹风
  │
  ├── 每 1 秒更新内部 progress
  ├── 每 1 秒通过 BLE Notify 推送进度
  └── 完成 → 蜂鸣器提示 → 恢复 idle 状态
```

## 注意事项

1. 设备应同时通过 BLE Notify 推送进度（双通道保障）
2. 清洗过程中 `POST /api/wash/start` 应返回 409
3. 固件需处理断网情况：网络恢复后自动重新连接 WiFi
4. 建议心跳机制：每 30 秒检查 WiFi 连接，断连则重连
