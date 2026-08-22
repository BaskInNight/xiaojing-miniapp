# 净界同频 · 硬件控制协议

## 概述

洗衣机硬件需同时提供 **BLE** 和 **LAN (HTTP)** 两种通信通道，供微信小程序控制。

- **BLE**: 设备发现、连接、配网、实时状态广播
- **LAN HTTP**: 所有控制指令（启动/停止/查询）通过 WiFi 局域网 RESTful API 传输

## 快速开始

```
洗衣机固件
  ├── 上电 → 初始化 BLE 广播（名称前缀 "JJTP"）
  ├── 连接 WiFi → 获取 DHCP IP
  ├── BLE 连接后 → 通过 Notify 推送设备信息（含 IP）
  └── HTTP 服务监听 → 等待 RESTful 指令
```

## 目录结构

```
export_hardware_control/
  ├── README.md              # 本文件
  ├── ble_protocol.md        # BLE 协议规范
  ├── lan_api.md             # LAN HTTP API 规范
  └── esp32_example/
      └── esp32_washing_machine.ino  # ESP32 参考实现
```

## 硬件要求

| 组件 | 要求 |
|------|------|
| 主控芯片 | 支持 BLE 4.0+ 和 WiFi（如 ESP32） |
| BLE 天线 | 板载或外置，保证 10m 通信距离 |
| WiFi 模块 | 2.4GHz，支持 DHCP 客户端 |
| 继电器/电机驱动 | 根据洗衣机硬件规格选择 |
| 传感器（可选） | 水位、温度、门锁状态等 |
