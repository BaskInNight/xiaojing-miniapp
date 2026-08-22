'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const washSource = fs.readFileSync(
  path.resolve(__dirname, '../miniprogram/pages/wash/wash.js'),
  'utf8'
);

let pageDefinition = null;
const sentCommands = [];
let scannedDevices = [];
let scanResults = null;
let adapterResetCount = 0;
let protocolSnapshot = {
  connected: true,
  protocolReady: true,
  deviceId: 'phone-ble-id',
  serviceId: 'fff0',
  writeCharId: 'fff1',
  notifyCharId: 'fff2',
  status: null
};
let sendCommandHandler = null;
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
  buildFormalPayload: () => ({ allow_uv: true, allow_dry: false }),
  sendProtocolCommand: async (command, payload) => {
    sentCommands.push({ command, payload });
    if (sendCommandHandler) {
      return sendCommandHandler(command, payload);
    }
    return { type: 'ack', ok: true, code: 'ACCEPTED', program_id: 77 };
  },
  setReconnectCallbacks: () => {},
  onDataReceived: () => () => {},
  connectDevice: async id => ({ deviceId: id, serviceId: 'fff0' }),
  scanDevices: async () => {
    if (scanResults && scanResults.length) return scanResults.shift();
    return scannedDevices;
  },
  resetAdapterForRecovery: async () => { adapterResetCount++; },
  rememberDevice: () => {},
  getRememberedDevice: () => null,
  disconnect: async () => {}
};

const booking = {
  _id: 'booking-123',
  status: '已预约',
  deviceId: 'JJTP-XIAOJING',
  deviceName: 'JJTP-XIAOJING',
  package: 'dry',
  steps: {
    soak: { enabled: true, count: 1, time: 6 },
    wash: { enabled: true, count: 3, time: 7 },
    rinse: { enabled: true, count: 3, time: 4 },
    dry: { enabled: true, count: 1, time: 20 }
  },
  totalTime: 59,
  totalPrice: 3,
  finalPrice: 2,
  bookingDate: '2020-01-01',
  bookingTime: '08:00'
};

const wx = {
  cloud: {
    callFunction: ({ name }) => {
      if (name === 'getOrderById') {
        return Promise.resolve({
          result: { code: 0, data: { order: booking } }
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

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testBookingHydration() {
  const page = makePage();
  let submits = 0;
  page.submitOrder = () => { submits++; };
  page.loadAndStartBooking('booking-123');
  await settle();

  assert.strictEqual(submits, 1);
  assert.strictEqual(page.data._sourceBookingId, 'booking-123');
  assert.strictEqual(page.data._currentOrderId, 'booking-123');
  assert.strictEqual(page.data.selectedPackage, 'dry');
  assert.strictEqual(page.data.customSteps.wash.count, 3);
  assert.strictEqual(page.data.customSteps.dry.enabled, true);
  assert.strictEqual(page.data.totalTime, 59);
  assert.strictEqual(page.data.finalPrice, 2);
  assert.strictEqual(page.data.bleDeviceName, 'JJTP-XIAOJING');
}

async function testExistingBookingSkipsCreateOrder() {
  const page = makePage();
  page.data._sourceBookingId = 'booking-123';
  page.data._currentOrderId = 'booking-123';
  page.data.bleDeviceName = 'JJTP-XIAOJING';
  page.ensureBleReadyForCommand = async () => ({ deviceId: 'phone-ble-id' });
  let saves = 0;
  page.saveOrder = async () => {
    saves++;
    return { code: 0, data: { orderId: 'wrong-new-order' } };
  };
  const statusUpdates = [];
  page.updateOrderRuntimeStatus = async (orderId, status, extra) => {
    statusUpdates.push({ orderId, status, extra });
  };
  page.loadCoupons = () => {};
  page.refreshDeviceStatus = async () => null;

  page.startWashViaBLE({
    deviceId: 'JJTP-XIAOJING',
    deviceName: 'JJTP-XIAOJING',
    steps: booking.steps,
    totalTime: 59
  });
  await settle();

  assert.strictEqual(saves, 0);
  assert.ok(sentCommands.some(item => item.command === 'start_formal'));
  assert.ok(statusUpdates.some(item =>
    item.orderId === 'booking-123' &&
    item.status === '进行中' &&
    item.extra.programId === 77
  ));
  assert.strictEqual(page.data._currentOrderId, 'booking-123');
  assert.strictEqual(page.data.activeProgramId, 77);
}

async function testImmediateSubmitDoesNotRequirePreconnection() {
  const page = makePage();
  page.data.isBooking = false;
  page.data.bleConnected = false;
  page.data.bleDeviceId = '';
  page.data.bleDeviceName = '';
  let prepared = 0;
  page.prepareImmediateOrder = orderData => {
    prepared++;
    assert.strictEqual(orderData.isBooking, false);
  };

  page.submitOrder();
  assert.strictEqual(prepared, 1);
}

async function testImmediateAutoDiscoversStrongestDevice() {
  const page = makePage();
  scannedDevices = [
    { deviceId: 'weak-id', name: 'JJTP-WEAK', RSSI: -72 },
    { deviceId: 'other-id', name: 'OTHER', RSSI: -10 },
    { deviceId: 'near-id', name: 'JJTP-XIAOJING', RSSI: -28 }
  ];

  const found = await page.resolveDeviceByName('');
  assert.strictEqual(found.deviceId, 'near-id');
  assert.strictEqual(found.name, 'JJTP-XIAOJING');
}

async function testImmediateScanRecoversOrphanedConnection() {
  const page = makePage();
  adapterResetCount = 0;
  scanResults = [
    [],
    [{ deviceId: 'recovered-id', name: 'JJTP-XIAOJING', RSSI: -31 }]
  ];

  const found = await page.resolveDeviceByName('');
  assert.strictEqual(adapterResetCount, 1);
  assert.strictEqual(found.deviceId, 'recovered-id');
  scanResults = null;
}

async function testBookingStillUsesBookingBranch() {
  const page = makePage();
  page.data.isBooking = true;
  let bookings = 0;
  let immediate = 0;
  page.createBooking = orderData => {
    bookings++;
    assert.strictEqual(orderData.isBooking, true);
  };
  page.prepareImmediateOrder = () => { immediate++; };

  page.submitOrder();
  assert.strictEqual(bookings, 1);
  assert.strictEqual(immediate, 0);
}

async function testConnectedImmediatePathDoesNotScan() {
  const page = makePage();
  page.data.isBooking = false;
  page.data.bleConnected = true;
  page.data.bleDeviceId = 'phone-ble-id';
  page.data.bleDeviceName = 'JJTP-XIAOJING';
  let ensureCalls = 0;
  let loadingCalls = 0;
  let modalCalls = 0;
  let startCalls = 0;
  const oldShowLoading = wx.showLoading;
  const oldShowModal = wx.showModal;
  wx.showLoading = () => { loadingCalls++; };
  wx.showModal = () => { modalCalls++; };
  page.ensureBleReadyForCommand = async () => { ensureCalls++; };
  page.startWashViaBLE = orderData => {
    startCalls++;
    assert.strictEqual(orderData.deviceName, 'JJTP-XIAOJING');
  };

  try {
    page.prepareImmediateOrder({
      deviceId: 'JJTP-XIAOJING',
      deviceName: 'JJTP-XIAOJING',
      bleDeviceId: 'phone-ble-id',
      totalTime: 30,
      finalPrice: 1,
      couponId: ''
    });
  } finally {
    wx.showLoading = oldShowLoading;
    wx.showModal = oldShowModal;
  }

  assert.strictEqual(ensureCalls, 0);
  assert.strictEqual(loadingCalls, 0);
  assert.strictEqual(modalCalls, 0);
  assert.strictEqual(startCalls, 1);
  assert.strictEqual(page.data.commandBusy, true);
}

function makeStartTestPage(orderId) {
  const page = makePage();
  page.data.bleConnected = true;
  page.data.bleDeviceId = 'phone-ble-id';
  page.data.bleDeviceName = 'JJTP-XIAOJING';
  page.ensureBleReadyForCommand = async () => ({ deviceId: 'phone-ble-id' });
  let saveCount = 0;
  page.saveOrder = async () => {
    saveCount++;
    return { code: 0, data: { orderId } };
  };
  page.updateOrderRuntimeStatus = async () => {};
  page.loadCoupons = () => {};
  page.refreshDeviceStatus = async () => null;
  return { page, getSaveCount: () => saveCount };
}

async function testBusyIdleRetriesSameOrderOnce() {
  const { page, getSaveCount } = makeStartTestPage('order-busy-idle');
  const before = sentCommands.length;
  let startCount = 0;
  protocolSnapshot.status = null;
  sendCommandHandler = async command => {
    if (command === 'start_formal') {
      startCount++;
      if (startCount === 1) {
        const error = new Error('BUSY');
        error.code = 'BUSY';
        throw error;
      }
      return { type: 'ack', ok: true, code: 'ACCEPTED', program_id: 88 };
    }
    if (command === 'get_status') {
      protocolSnapshot.status = { state: 1, program_id: 0 };
      return { type: 'status', ok: true };
    }
    throw new Error(`Unexpected command: ${command}`);
  };

  try {
    page.startWashViaBLE({
      deviceId: 'JJTP-XIAOJING',
      deviceName: 'JJTP-XIAOJING',
      totalTime: 30
    });
    await wait(800);
  } finally {
    sendCommandHandler = null;
    protocolSnapshot.status = null;
  }

  const commands = sentCommands.slice(before).map(item => item.command);
  assert.deepStrictEqual(commands, ['start_formal', 'get_status', 'start_formal']);
  assert.strictEqual(getSaveCount(), 1);
  assert.strictEqual(page.data.activeProgramId, 88);
  assert.strictEqual(page.data.isWashing, true);
  assert.strictEqual(page.data.awaitingLoad, true);
}

async function testBusyWaitLoadRecoversAcceptedStart() {
  const { page, getSaveCount } = makeStartTestPage('order-busy-recovered');
  const before = sentCommands.length;
  protocolSnapshot.status = null;
  sendCommandHandler = async command => {
    if (command === 'start_formal') {
      const error = new Error('BUSY');
      error.code = 'BUSY';
      throw error;
    }
    if (command === 'get_status') {
      protocolSnapshot.status = { state: 2, program_id: 99 };
      return { type: 'status', ok: true };
    }
    throw new Error(`Unexpected command: ${command}`);
  };

  try {
    page.startWashViaBLE({
      deviceId: 'JJTP-XIAOJING',
      deviceName: 'JJTP-XIAOJING',
      totalTime: 30
    });
    await wait(450);
  } finally {
    sendCommandHandler = null;
    protocolSnapshot.status = null;
  }

  const commands = sentCommands.slice(before).map(item => item.command);
  assert.deepStrictEqual(commands, ['start_formal', 'get_status']);
  assert.strictEqual(getSaveCount(), 1);
  assert.strictEqual(page.data.activeProgramId, 99);
  assert.strictEqual(page.data.isWashing, true);
  assert.strictEqual(page.data.awaitingLoad, true);
}

async function main() {
  await testBookingHydration();
  await testExistingBookingSkipsCreateOrder();
  await testImmediateSubmitDoesNotRequirePreconnection();
  await testImmediateAutoDiscoversStrongestDevice();
  await testImmediateScanRecoversOrphanedConnection();
  await testBookingStillUsesBookingBranch();
  await testConnectedImmediatePathDoesNotScan();
  await testBusyIdleRetriesSameOrderOnce();
  await testBusyWaitLoadRecoversAcceptedStart();
  console.log('BOOKING_FLOW_TESTS=23/23 PASS');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
