# 小净微信小程序

小净非交叉污染洗护设备配套软件，包含微信小程序、微信云开发云函数、Vue 管理后台，以及设备控制协议和测试脚本。本仓库为交接用干净基线，不包含依赖目录、构建产物、个人开发者配置、AI 工作目录或真实密钥。

## 项目组成

```text
.
├── miniprogram/              微信小程序页面、组件与 BLE/LAN 工具
├── cloudfunctions/           登录、订单、设备、优惠券、支付等云函数
├── admin/                    Vue 3 + Vite 管理后台
├── tools/                    协议、页面和业务流程测试脚本
├── export_hardware_control/  设备控制协议及 ESP32 示例
└── project.config.json       微信开发者工具项目配置
```

## 环境要求

- 微信开发者工具（基础库当前配置为 3.16.0）
- 已开通微信云开发的测试或正式环境
- Node.js 18 或更高版本
- npm 8 或更高版本

## 导入小程序

1. 使用微信开发者工具导入仓库根目录。
2. 确认 `project.config.json` 中的小程序 AppID 属于当前团队。
3. 在 `miniprogram/app.js` 中检查 `wx.cloud.init()` 的云环境 ID；当前基线为 `cloud1-d6g8uxp6ha8bb9404`。
4. 如需个人开发工具选项，由微信开发者工具自动生成 `project.private.config.json`，不要提交该文件。

## 云函数

`cloudfunctions/` 下每个子目录是一个独立云函数。首次部署前，在微信开发者工具中选择对应云环境，并对所需函数执行“上传并部署：云端安装依赖”。

地理编码函数需要腾讯地图 WebService Key：

```powershell
Copy-Item cloudfunctions/geocode/config.example.js cloudfunctions/geocode/config.js
```

然后仅在本地填写 `TENCENT_MAP_KEY`。`config.js` 已被 `.gitignore` 排除。

部分功能依赖云数据库集合，例如用户、订单、设备、优惠券和 `location_cache`。正式部署前应在目标云环境核对集合、索引、权限和初始数据。

管理云函数部署前必须配置环境变量 `JWT_SECRET`。如确需临时启用配置文件中的初始账号，可同时设置 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD`；更推荐使用 `seedAdmin` 显式传入至少 12 位密码后，将账号保存为哈希记录。

## 管理后台

```bash
cd admin
npm ci
npm run dev
```

生产构建：

```bash
cd admin
npm ci
npm run build
```

生成的 `admin/dist/` 不纳入版本管理。

## 测试脚本

`tools/` 中的脚本覆盖 BLE 协议、预约流程、紫外流程、自检、页面契约和摆动控制等逻辑。可在仓库根目录使用 Node.js 逐个运行：

```bash
node tools/test_ble_protocol.js
node tools/test_booking_flow.js
node tools/test_page_contract.js
```

涉及真机蓝牙、云函数、支付或设备局域网接口的功能，仍需在微信开发者工具和手机端验证。

## 安全与交接约定

- 不提交腾讯地图 Key、支付密钥、访问令牌或个人微信开发者配置。
- 不在小程序源码中预置语音 API Key 或设备 Wi-Fi 密码；由授权人员在运行时通过安全配网页面写入设备。
- 不提交任何 `node_modules/`、`admin/dist/`、日志或临时测试输出。
- 修改 BLE/LAN 控制命令时，同步维护 `export_hardware_control/` 中的协议文档。
- 云环境 ID 和小程序 AppID 不是访问密钥，但切换测试/生产环境时必须复核。
- 本仓库包含整理时工作区中的最新有效修改，包括洗护页面及摆动/Snapcast 测试脚本。
