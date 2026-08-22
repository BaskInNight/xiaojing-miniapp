# 小净 ESP32 BLE V1 指令词典

> 协议真源：ESP-IDF 工程 `components/app_protocol` 与
> `components/ble_transport`。小程序不得直接发送 GPIO、继电器、PWM、
> 电机、阀门或 PTC 指令。

## 1. GATT

| 项目 | 值 |
|---|---|
| 广播名 | `JJTP-XIAOJING`（扫描兼容 `JJTP` 前缀） |
| Service | `0000FFF0-0000-1000-8000-00805F9B34FB` |
| RX / Write | `0000FFF1-0000-1000-8000-00805F9B34FB` |
| TX / Notify | `0000FFF2-0000-1000-8000-00805F9B34FB` |
| 最大应用帧 | 2048 bytes |

小程序写入使用 20-byte 安全分片。ESP32 的 Notify 会按协商 MTU 分片，
因此接收端必须按 JSON 括号深度、字符串和转义状态重组；一次 Notify
不等于一条消息。

## 2. V1 命令信封

```json
{"v":1,"type":"cmd","seq":123,"cmd":"get_status"}
```

- `seq` 为 1..4294967295，跳过 0。
- 超时重试必须复用同一 `seq` 和完全相同的 JSON。
- 同一 `seq` + 同一 payload：ESP32 重放缓存 ACK。
- 同一 `seq` + 不同 payload：返回 `SEQ_CONFLICT`。
- GATT 写成功只表示字节写入，不表示命令被设备接受。

ACK：

```json
{"v":1,"type":"ack","seq":123,"ok":true,"code":"OK","detail":0}
```

NACK：

```json
{"v":1,"type":"nack","seq":123,"ok":false,"code":"INVALID_STATE","detail":0}
```

启动成功 ACK 还包含 `program_id`，`code` 为 `ACCEPTED`。

## 3. 当前命令

| cmd | 用途 | 额外字段 |
|---|---|---|
| `hello` | 握手；随后发布 capabilities 和 status | 无 |
| `get_status` | 请求权威状态 | 无 |
| `start_formal` | 启动正式安全程序 | `allow_uv`, `allow_dry` |
| `start_demo` | 启动演示程序 | `allow_dry` |
| `submit_plan` | 提交自定义 planner intent | `allow_uv`, `allow_dry`, `actions` |
| `ack_load` | 确认衣物已放入 | 无 |
| `ack_unload` | 确认衣物已取出 | 无 |
| `skip_uv` | 跳过当前 UV 步骤 | 无 |
| `abort_reset` | 安全中止并回最终位置 | 无 |
| `ack_fault` | 确认故障并尝试清除 | 无 |

`pause` / `resume` 当前返回 `NOT_SUPPORTED`，小程序不得显示为可用功能。

旧 JSON `{"cmd":"start"}` / `{"cmd":"stop"}` 仅在固件 legacy 开关启用时
兼容；它们不携带可靠 `seq`，也不能表达当前 planner，生产小程序不再使用。

## 4. 正式程序交互

```text
start_formal ACK(ACCEPTED)
  -> status.state = 2 (WAITING_LOAD)
  -> 用户关好舱门，发送 ack_load
  -> status.state = 3 (RUNNING)，按设备 planner 执行
  -> status.state = 4 (WAITING_UNLOAD)
  -> 用户取出衣物，发送 ack_unload
  -> status.state = 5 (UV) 或安全收尾
  -> status.state = 1 (IDLE), progress = 100
```

断开手机 BLE 不会取消正在运行的程序。需要停止时必须连接设备并发送
`abort_reset`，收到 ACK 后继续等待 status 回到 IDLE。

## 5. Status

```json
{
  "v": 1,
  "type": "status",
  "revision": 8,
  "state": 3,
  "phase": 6,
  "program_id": 4,
  "current_step": 5,
  "total_steps": 17,
  "progress": 35,
  "position": 0,
  "target_position": 0,
  "water_full": true,
  "heater_on": false,
  "uv_on": false,
  "ble_connected": true,
  "fault_code": 0,
  "fault_detail": 0
}
```

`state`：

| 值 | 含义 |
|---:|---|
| 0 | BOOTING |
| 1 | IDLE |
| 2 | WAITING_LOAD |
| 3 | RUNNING |
| 4 | WAITING_UNLOAD |
| 5 | UV |
| 6 | PAUSED（当前命令不支持进入） |
| 7 | RESETTING |
| 8 | FAULT |

`phase`：

| 值 | 含义 |
|---:|---|
| 0 | IDLE |
| 1 | MOVE_POSITION |
| 2 | HOME_BL50 |
| 3 | WATER_SOURCE_FILL |
| 4 | WATER_TRANSFER |
| 5 | DETERGENT |
| 6 | PULSATOR_WASH |
| 7 | DRUM_WASH |
| 8 | DRAIN |
| 9 | SPIN |
| 10 | DRY |
| 11 | UV |
| 12 | DONE |

状态消息是设备权威数据。小程序不得用本地计时器覆盖 `progress`，也不得
因 BLE 断线把设备状态改成“已停止”。

## 6. 自定义 actions（暂未在当前 UI 开放）

支持的 `type`：

`move_position`, `water_in`, `detergent`, `pulsator_wash`, `drum_wash`,
`drain`, `spin`, `dry`, `uv`。

通用字段为 `enabled`, `duration_ms`, `rounds`, `intensity`, `position`。
planner 会自动插入所需进水、排水和姿态步骤。旧 UI 的“浸泡/漂洗次数”
无法安全地一一转换，因此当前小程序只使用正式套餐。
