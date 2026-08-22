'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const washJs = fs.readFileSync(
  path.join(root, 'miniprogram/pages/wash/wash.js'), 'utf8'
);
const washWxml = fs.readFileSync(
  path.join(root, 'miniprogram/pages/wash/wash.wxml'), 'utf8'
);
const devicesJs = fs.readFileSync(
  path.join(root, 'miniprogram/pages/devices/devices.js'), 'utf8'
);
const bookingJs = fs.readFileSync(
  path.join(root, 'miniprogram/pages/booking/booking.js'), 'utf8'
);
const devicesWxml = fs.readFileSync(
  path.join(root, 'miniprogram/pages/devices/devices.wxml'), 'utf8'
);
const ordersJs = fs.readFileSync(
  path.join(root, 'miniprogram/pages/orders/orders.js'), 'utf8'
);
const ordersWxml = fs.readFileSync(
  path.join(root, 'miniprogram/pages/orders/orders.wxml'), 'utf8'
);
const profileJs = fs.readFileSync(
  path.join(root, 'miniprogram/pages/profile/profile.js'), 'utf8'
);
const profileWxml = fs.readFileSync(
  path.join(root, 'miniprogram/pages/profile/profile.wxml'), 'utf8'
);
const appJs = fs.readFileSync(path.join(root, 'miniprogram/app.js'), 'utf8');
const bleJs = fs.readFileSync(
  path.join(root, 'miniprogram/utils/ble.js'), 'utf8'
);
const createOrderJs = fs.readFileSync(
  path.join(root, 'cloudfunctions/createOrder/index.js'), 'utf8'
);
const getUserOrdersJs = fs.readFileSync(
  path.join(root, 'cloudfunctions/getUserOrders/index.js'), 'utf8'
);
const updateOrderStatusJs = fs.readFileSync(
  path.join(root, 'cloudfunctions/updateOrderRuntimeStatus/index.js'), 'utf8'
);
const project = JSON.parse(
  fs.readFileSync(path.join(root, 'project.config.json'), 'utf8')
);

const handlers = [];
const bindingPattern = /\bbind(?:tap|change|input|confirm)="([^"]+)"/g;
let match;
while ((match = bindingPattern.exec(washWxml)) !== null) {
  handlers.push(match[1]);
}
const missing = Array.from(new Set(handlers)).filter(name =>
  !new RegExp('\\b' + name + '\\s*:\\s*function\\s*\\(').test(washJs)
);
assert.deepStrictEqual(missing, [], `missing WXML handlers: ${missing.join(', ')}`);

assert.ok(washJs.includes('const sendStart = () => ble.sendProtocolCommand('));
assert.ok(washJs.includes("'start_formal'"));
assert.ok(washJs.includes('return this.sendStartWithBusyRecovery(orderData).then((ack) =>'));
assert.ok(washJs.includes("ble.sendProtocolCommand('ack_load'"));
assert.ok(washJs.includes("ble.sendProtocolCommand('ack_unload'"));
assert.ok(washJs.includes("ble.sendProtocolCommand('skip_uv'"));
assert.ok(washJs.includes("ble.sendProtocolCommand('abort_reset'"));
assert.ok(washJs.includes("ble.sendProtocolCommand('ack_fault'"));
assert.ok(!washJs.includes('ble.buildWashCommand'));
assert.ok(!washJs.includes('ble.buildStopCommand'));
assert.ok(!washJs.includes('ble.sendCommand('));
assert.ok(!washJs.includes('wx.offBLECharacteristicValueChange'));

assert.ok(devicesJs.includes('encodeURIComponent(matched.deviceId)'));
assert.ok(devicesJs.includes('encodeURIComponent(matched.name)'));
assert.ok(devicesJs.includes('app.globalData.bleConnected'));
assert.ok(devicesJs.includes('_connected: true'));
assert.ok(devicesWxml.includes('item._connected'));

assert.ok(washJs.includes('deviceId: this.data.bleDeviceName || this.data.bleDeviceId'));
assert.ok(washJs.includes('bleDeviceId: this.data.bleDeviceId'));
assert.ok(washJs.includes('orderData.bleDeviceId = snapshot.deviceId'));
assert.ok(washJs.includes('orderData.deviceId = orderData.deviceName'));
assert.ok(washJs.includes('function isRealBleDeviceId'));
assert.ok(!washWxml.includes('!protocolReady))'));
assert.ok(!washJs.includes('      this.connectBLE();'));
assert.ok(washJs.includes('this.data._startNow'));
assert.ok(washJs.includes('this.startWashViaBLE(orderData);'));
assert.ok(washJs.includes("statusText: '正在加载预约订单...'"));
assert.ok(washJs.includes("this.loadAndStartBooking(options.bookingId || '')"));
assert.ok(washJs.includes("name: 'getOrderById'"));
assert.ok(washJs.includes('if (this.data._sourceBookingId)'));
assert.ok(washJs.includes("name: 'updateOrderRuntimeStatus'"));
assert.ok(washJs.includes("'启动待确认' : '启动失败'"));
assert.ok(washJs.includes('} else if (optionDeviceName) {'));
assert.ok(!washWxml.includes('自动启动'));
assert.ok(washWxml.includes('到点后确认启动'));
assert.ok(bookingJs.includes('app.globalData.bleConnected'));
assert.ok(bookingJs.includes('booking.bleDeviceId'));
assert.ok(bookingJs.includes('function routeValue'));
assert.ok(bookingJs.includes('setInterval(() =>'));
assert.ok(bookingJs.includes('stopBookingClock'));
assert.ok(bleJs.includes("makeError('BLE_DEVICE_ID_INVALID'"));
assert.ok(appJs.includes('appVersion: version.MINIAPP_VERSION'));
assert.ok(profileJs.includes('appVersion'));
assert.ok(profileWxml.includes('APP VERSION {{appVersion}}'));
assert.ok(profileJs.includes('formatBleDebug'));
assert.ok(profileWxml.includes('BLE DEBUG {{bleDebugText}}'));
assert.ok(bleJs.includes('getLastConnectDebug'));
assert.ok(bleJs.includes('if (activeScan) return activeScan.promise'));
assert.ok(bleJs.includes('if (connectInFlightDeviceId === deviceId) return connectInFlight'));
assert.ok(bleJs.includes('function resetAdapterForRecovery()'));
assert.ok(bleJs.includes('function rememberDevice(deviceId, deviceName)'));
assert.ok(washJs.includes('ble.resetAdapterForRecovery()'));
assert.ok(washJs.includes('this.warmBleConnection()'));
assert.ok(washJs.includes('warmBleConnection: function ()'));
assert.ok(washJs.includes('sendStartWithBusyRecovery: function (orderData)'));
assert.ok(washJs.includes("'RECOVERED_ALREADY_STARTED'"));
assert.ok(washJs.includes("title: '正在创建订单...'"));
assert.ok(!washJs.includes("title: '鍒涘缓璁㈠崟...'"));
assert.ok(!washJs.includes('snapshot.protocolReady || app.globalData.bleConnected'));
assert.ok(washJs.includes('const snapshotReady = snapshot.connected && snapshot.protocolReady'));
assert.ok(appJs.includes("const ble = require('./utils/ble.js')"));
assert.ok(appJs.includes('ble.disconnect()'));
assert.ok(!appJs.includes('wx.closeBLEConnection({'));
assert.ok(appJs.includes("deviceInfo.platform === 'devtools'"));
assert.ok(appJs.includes('wx.openBluetoothAdapter({'));

assert.ok(createOrderJs.includes("status: event.isBooking ? '已预约' : '待启动'"));
assert.ok(createOrderJs.includes('clientRequestId'));
assert.ok(!createOrderJs.includes("data: { status: 'working'"));
assert.ok(getUserOrdersJs.includes('_id: o._id'));
assert.ok(getUserOrdersJs.includes('id: o._id'));
assert.ok(getUserOrdersJs.includes("deviceId: o.deviceId || ''"));
assert.ok(getUserOrdersJs.includes("status === 'active'"));
assert.ok(updateOrderStatusJs.includes("const TRANSITIONS = {"));
assert.ok(updateOrderStatusJs.includes("where({ _id: orderId, _openid: openid })"));
assert.ok(updateOrderStatusJs.includes("nextStatus === '进行中'"));
assert.ok(ordersJs.includes("{ key: 'active', label: '进行中' }"));
assert.ok(ordersWxml.includes('data-id="{{item._id || item.id}}"'));

assert.ok(bleJs.includes("const SERVICE_UUID = '0000FFF0"));
assert.ok(bleJs.includes("const WRITE_CHAR_UUID = '0000FFF1"));
assert.ok(bleJs.includes("const NOTIFY_CHAR_UUID = '0000FFF2"));
assert.ok(bleJs.includes("sendProtocolCommand('hello'"));

assert.strictEqual(project.miniprogramRoot, 'miniprogram/');
assert.strictEqual(project.cloudfunctionRoot, 'cloudfunctions/');

console.log(`PAGE_CONTRACT_TESTS=${handlers.length + 42}/${handlers.length + 42} PASS`);
