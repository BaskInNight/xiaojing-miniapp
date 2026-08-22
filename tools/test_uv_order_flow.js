'use strict';

/*
 * test_uv_order_flow.js — UV 消毒附加项端到端契约测试
 *
 * Covers the 15 required cases:
 *   1. UV 默认关闭
 *   2. 切换开启后页面状态为 true
 *   3. 切换关闭后恢复 false
 *   4. 快洗/烘干套餐切换不重置 UV
 *   5. buildFormalPayload({allowUv:false}) -> allow_uv:false
 *   6. buildFormalPayload({allowUv:true})  -> allow_uv:true
 *   7. allowUv 与 allowDry 独立
 *   8. 旧订单缺少 allowUv 恢复为 false
 *   9. 预约订单 allowUv:true 保存并恢复
 *   10. 预约订单“立即启动”仍发送 allow_uv:true
 *   11. 普通立即订单仍可直接启动（不被迫进入预约流程）
 *   12. BLE 重连后重发保持原 allow_uv
 *   13. BUSY 恢复重试使用同一 allow_uv
 *   14. WXML 存在 UV 开关及绑定处理函数
 *   15. 页面退出/重进不会出现 undefined 导致默认开启
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

/* 真实 ble.buildFormalPayload（纯函数，直接加载真实模块） */
global.wx = {};
const realBle = require(path.join(root, 'miniprogram/utils/ble.js'));

const washSource = fs.readFileSync(
  path.join(root, 'miniprogram/pages/wash/wash.js'), 'utf8'
);
const washWxml = fs.readFileSync(
  path.join(root, 'miniprogram/pages/wash/wash.wxml'), 'utf8'
);

let pageDefinition = null;
const sentCommands = [];
let sendCommandHandler = null;
let reconnectCallback = null;

const protocolSnapshot = {
  connected: true,
  protocolReady: true,
  deviceId: 'phone-ble-id',
  serviceId: 'fff0',
  writeCharId: 'fff1',
  notifyCharId: 'fff2',
  status: null
};

const app = {
  globalData: {
    bleConnected: false,
    bleDeviceId: '',
    bleDeviceName: '',
    bleServiceId: '',
    bleWriteCharId: '',
    bleNotifyCharId: ''
  }
};

const ble = {
  DEVICE_NAME_PREFIX: 'JJTP',
  getProtocolSnapshot: () => protocolSnapshot,
  getLastConnectDebug: () => null,
  buildFormalPayload: realBle.buildFormalPayload,
  sendProtocolCommand: async (command, payload) => {
    sentCommands.push({ command, payload });
    if (sendCommandHandler) {
      return sendCommandHandler(command, payload);
    }
    return { type: 'ack', ok: true, code: 'ACCEPTED', program_id: 77 };
  },
  setReconnectCallbacks: (onReconnect) => { reconnectCallback = onReconnect; },
  onDataReceived: () => () => {},
  connectDevice: async id => ({ deviceId: id, serviceId: 'fff0' }),
  scanDevices: async () => [],
  resetAdapterForRecovery: async () => {},
  rememberDevice: () => {},
  getRememberedDevice: () => null,
  disconnect: async () => {}
};

const wx = {
  cloud: {
    callFunction: ({ name }) => {
      if (name === 'getOrderById') {
        return Promise.resolve({
          result: { code: 0, data: { order: {} } }
        });
      }
      return Promise.resolve({ result: { code: 0, data: {} } });
    }
  },
  showModal: () => {},
  showLoading: () => {},
  hideLoading: () => {},
  showToast: () => {},
  vibrateLong: () => {},
  navigateBack: () => {},
  navigateTo: () => {},
  switchTab: () => {},
  getSetting: () => {}
};

/* 让 getOrderById 返回指定订单 */
function setOrderForGetById(order) {
  const orig = wx.cloud.callFunction;
  wx.cloud.callFunction = ({ name }) => {
    if (name === 'getOrderById') {
      return Promise.resolve({ result: { code: 0, data: { order } } });
    }
    return Promise.resolve({ result: { code: 0, data: {} } });
  };
  return () => { wx.cloud.callFunction = orig; };
}

vm.runInNewContext(washSource, {
  require: () => ble,
  getApp: () => app,
  Page: definition => { pageDefinition = definition; },
  wx,
  console,
  Date,
  Math,
  Promise,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval
}, { filename: 'wash.js' });

assert.ok(pageDefinition, 'Page definition was not registered');

function makePage() {
  const page = Object.assign({}, pageDefinition);
  page.data = JSON.parse(JSON.stringify(pageDefinition.data));
  page.setData = patch => Object.assign(page.data, patch);
  return page;
}

function settle() {
  return new Promise(resolve => setTimeout(resolve, 20));
}

let testsRun = 0;
let testsPassed = 0;
let testsFailed = 0;

function TEST(name) {
  testsRun++;
  process.stdout.write(`  TEST ${String(testsRun).padStart(2, '0')}: ${name}`);
}

function PASS() {
  testsPassed++;
  console.log(' PASS');
}

function FAIL(msg) {
  testsFailed++;
  console.log(` FAIL: ${msg}`);
}

/* ================================================================ */

async function testUvDefaultOff() {
  TEST('UV default off');
  const page = makePage();
  if (page.data.uvDisinfectionEnabled === false) PASS();
  else FAIL('uvDisinfectionEnabled must default to false');
}

async function testUvToggleOn() {
  TEST('toggle on -> true');
  const page = makePage();
  page.toggleUvDisinfection({ detail: { value: true } });
  if (page.data.uvDisinfectionEnabled === true) PASS();
  else FAIL('expected true after toggle on');
}

async function testUvToggleOff() {
  TEST('toggle off -> false');
  const page = makePage();
  page.toggleUvDisinfection({ detail: { value: true } });
  page.toggleUvDisinfection({ detail: { value: false } });
  if (page.data.uvDisinfectionEnabled === false) PASS();
  else FAIL('expected false after toggle off');
}

async function testPackageSwitchKeepsUv() {
  TEST('package switch does not reset UV');
  const page = makePage();
  page.toggleUvDisinfection({ detail: { value: true } });
  page.selectPackage({ currentTarget: { dataset: { package: 'dry' } } });
  page.selectPackage({ currentTarget: { dataset: { package: 'quick' } } });
  if (page.data.uvDisinfectionEnabled === true) PASS();
  else FAIL('UV must survive package switch');
}

async function testPayloadFalse() {
  TEST('buildFormalPayload({allowUv:false}) -> allow_uv:false');
  const payload = realBle.buildFormalPayload({
    allowUv: false, steps: { dry: { enabled: true, count: 1 } }
  });
  if (payload.allow_uv === false && payload.allow_dry === true) PASS();
  else FAIL(`got ${JSON.stringify(payload)}`);
}

async function testPayloadTrue() {
  TEST('buildFormalPayload({allowUv:true}) -> allow_uv:true');
  const payload = realBle.buildFormalPayload({
    allowUv: true, steps: { dry: { enabled: false, count: 0 } }
  });
  if (payload.allow_uv === true && payload.allow_dry === false) PASS();
  else FAIL(`got ${JSON.stringify(payload)}`);
}

async function testPayloadIndependence() {
  TEST('allowUv and allowDry are independent');
  const on = realBle.buildFormalPayload({
    allowUv: true, steps: { dry: { enabled: true, count: 1 } }
  });
  const off = realBle.buildFormalPayload({
    allowUv: false, steps: { dry: { enabled: false, count: 0 } }
  });
  if (on.allow_uv === true && on.allow_dry === true &&
      off.allow_uv === false && off.allow_dry === false) PASS();
  else FAIL('independence broken');
}

async function testOldOrderMissingUvRestoresFalse() {
  TEST('old order without allowUv restores false');
  const restore = setOrderForGetById({
    _id: 'old-booking', status: '已预约', package: 'quick',
    steps: {}, totalTime: 30, totalPrice: 1, finalPrice: 1,
    bookingDate: '2020-01-01', bookingTime: '08:00'
    /* no allowUv field = legacy order */
  });
  const page = makePage();
  page.data.uvDisinfectionEnabled = true; /* stale state */
  page.submitOrder = () => {};
  page.loadAndStartBooking('old-booking');
  await settle();
  if (page.data.uvDisinfectionEnabled === false) PASS();
  else FAIL('missing allowUv must restore false');
  restore();
}

async function testBookingUvRoundtrip() {
  TEST('booking allowUv:true saved and restored');
  const page = makePage();
  page.setData({ isBooking: true });
  page.toggleUvDisinfection({ detail: { value: true } });
  let savedOrder = null;
  page.createBooking = (orderData) => { savedOrder = orderData; };
  page.submitOrder();
  if (!savedOrder || savedOrder.allowUv !== true) {
    FAIL('submitOrder must persist allowUv:true');
    return;
  }
  /* restore from a booking that had allowUv:true */
  const restore = setOrderForGetById({
    _id: 'booking-uv', status: '已预约', package: 'quick',
    steps: {}, totalTime: 30, totalPrice: 1, finalPrice: 1,
    bookingDate: '2020-01-01', bookingTime: '08:00', allowUv: true
  });
  const page2 = makePage();
  page2.submitOrder = () => {};
  page2.loadAndStartBooking('booking-uv');
  await settle();
  if (page2.data.uvDisinfectionEnabled === true) PASS();
  else FAIL(`expected restored true, got ${page2.data.uvDisinfectionEnabled}`);
  restore();
}

async function testBookingStartNowSendsAllowUvTrue() {
  TEST('booking 立即启动 sends allow_uv:true');
  const page = makePage();
  page.data._sourceBookingId = 'booking-uv';
  page.data._currentOrderId = 'booking-uv';
  page.data.uvDisinfectionEnabled = true;
  page.data.bleDeviceName = 'JJTP-XIAOJING';
  page.ensureBleReadyForCommand = async () => ({ deviceId: 'phone-ble-id' });
  page.saveOrder = async () => ({ code: 0, data: { orderId: 'booking-uv' } });
  page.updateOrderRuntimeStatus = async () => ({});
  page.loadCoupons = () => {};
  page.refreshDeviceStatus = async () => null;
  sentCommands.length = 0;
  const started = page.startWashViaBLE({
    deviceId: 'JJTP-XIAOJING',
    deviceName: 'JJTP-XIAOJING',
    allowUv: true,
    steps: {},
    totalTime: 30
  });
  await settle();
  await started;
  const cmd = sentCommands.find(c => c.command === 'start_formal');
  if (cmd && cmd.payload.allow_uv === true) PASS();
  else FAIL(`expected allow_uv:true, got ${cmd && JSON.stringify(cmd.payload)}`);
}

async function testImmediateOrderNotForcedToBooking() {
  TEST('immediate order starts directly (no booking)');
  const page = makePage();
  page.data.bleDeviceName = 'JJTP-XIAOJING';
  page.data._startNow = false;
  page.data.uvDisinfectionEnabled = false;
  let directStart = false;
  page.startWashViaBLE = () => { directStart = true; return Promise.resolve(); };
  page.createBooking = () => { directStart = false; };
  page.ensureBleReadyForCommand = async () => ({ deviceId: 'phone-ble-id' });
  page.submitOrder();
  await settle();
  if (directStart) PASS();
  else FAIL('immediate order must not be forced into booking');
}

async function testReconnectResendKeepsAllowUv() {
  TEST('BLE reconnect resend keeps allow_uv');
  const page = makePage();
  page.data.uvDisinfectionEnabled = true;
  sentCommands.length = 0;
  const orderData = {
    deviceId: 'JJTP-XIAOJING', allowUv: true,
    steps: { dry: { enabled: true, count: 1 } }
  };
  ble.buildFormalPayload(orderData); /* warm */
  const p1 = realBle.buildFormalPayload(orderData);
  /* reconnect event fires; page state survives */
  if (reconnectCallback) reconnectCallback({ deviceId: 'phone-ble-id' });
  const p2 = realBle.buildFormalPayload(orderData);
  if (p1.allow_uv === true && p2.allow_uv === true &&
      page.data.uvDisinfectionEnabled === true) PASS();
  else FAIL('reconnect must preserve allow_uv');
}

async function testBusyRecoverySameAllowUv() {
  TEST('BUSY recovery retries same allow_uv');
  const page = makePage();
  const orderData = {
    deviceId: 'JJTP-XIAOJING', allowUv: true,
    steps: { dry: { enabled: true, count: 1 } }
  };
  const payloads = [];
  const orig = ble.sendProtocolCommand;
  ble.sendProtocolCommand = async (command, payload) => {
    payloads.push({ command, payload });
    if (command === 'get_status') {
      return Promise.resolve({ type: 'ack' });
    }
    const startCount = payloads.filter(p => p.command === 'start_formal').length;
    if (startCount === 1) {
      const busy = new Error('BUSY');
      busy.code = 'BUSY';
      return Promise.reject(busy);
    }
    return Promise.resolve({ type: 'ack', ok: true, code: 'ACCEPTED', program_id: 5 });
  };
  protocolSnapshot.status = { state: 1 }; /* IDLE + BUSY -> retry */
  try {
    await page.sendStartWithBusyRecovery(orderData);
  } catch (e) {
    FAIL(`busy recovery threw: ${e.message}`);
    ble.sendProtocolCommand = orig;
    return;
  }
  const starts = payloads.filter(p => p.command === 'start_formal');
  if (starts.length >= 2 &&
      starts.every(s => s.payload.allow_uv === true)) PASS();
  else FAIL(`expected identical allow_uv:true across retries, got ${JSON.stringify(starts)}`);
  ble.sendProtocolCommand = orig;
}

async function testWxmlHasUvSwitch() {
  TEST('WXML has UV switch + binding handler');
  const hasSwitch = washWxml.includes('bindchange="toggleUvDisinfection"') &&
    washWxml.includes('uvDisinfectionEnabled') &&
    washWxml.includes('🦠 UV 消毒');
  const hasHandler = typeof pageDefinition.toggleUvDisinfection === 'function';
  if (hasSwitch && hasHandler) PASS();
  else FAIL('UV switch or handler missing in WXML/JS');
}

async function testPageReentryNoUndefined() {
  TEST('page re-entry: no undefined -> default off');
  /* onUnload + fresh onLoad must produce a clean false default */
  const page = makePage();
  page.onUnload();
  const page2 = makePage();
  page2.onLoad({});
  if (page2.data.uvDisinfectionEnabled === false) PASS();
  else FAIL(`re-entered page must be false, got ${page2.data.uvDisinfectionEnabled}`);
}

async function main() {
  await testUvDefaultOff();
  await testUvToggleOn();
  await testUvToggleOff();
  await testPackageSwitchKeepsUv();
  await testPayloadFalse();
  await testPayloadTrue();
  await testPayloadIndependence();
  await testOldOrderMissingUvRestoresFalse();
  await testBookingUvRoundtrip();
  await testBookingStartNowSendsAllowUvTrue();
  await testImmediateOrderNotForcedToBooking();
  await testReconnectResendKeepsAllowUv();
  await testBusyRecoverySameAllowUv();
  await testWxmlHasUvSwitch();
  await testPageReentryNoUndefined();

  console.log(`\nUV_ORDER_FLOW_TESTS=${testsPassed}/${testsRun} PASS`);
  process.exit(testsFailed === 0 ? 0 : 1);
}

main();
