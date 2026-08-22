'use strict';

const assert = require('assert');
const protocol = require('../miniprogram/utils/ble_protocol');

let valueListener = null;
let connectionListener = null;
let storageSeq = 100;
const deviceRx = new protocol.JsonFrameAssembler();
const requests = [];
let createConnectionCount = 0;
let startDiscoveryCount = 0;
let deviceFoundListener = null;
let dropFirstGetStatus = true;
let notifyChain = Promise.resolve();

function callbackSuccess(options, value) {
  setTimeout(() => options.success && options.success(value || {}), 0);
}

function emitMessage(message) {
  const bytes = protocol.encodeUtf8(JSON.stringify(message));
  const sizes = [3, 7, 2, 11, 5];
  notifyChain = notifyChain.then(async () => {
    let offset = 0;
    let index = 0;
    while (offset < bytes.length) {
      const end = Math.min(offset + sizes[index % sizes.length], bytes.length);
      const part = bytes.slice(offset, end);
      valueListener({
        deviceId: 'dev-1',
        characteristicId: '0000FFF2-0000-1000-8000-00805F9B34FB',
        value: protocol.arrayBufferFromBytes(part)
      });
      offset = end;
      index++;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  });
}

function respondToRequest(message) {
  requests.push(message);
  if (message.cmd === 'get_status' && dropFirstGetStatus) {
    dropFirstGetStatus = false;
    return;
  }
  const rejected = message.cmd === 'skip_uv';
  emitMessage({
    v: 1,
    type: rejected ? 'nack' : 'ack',
    seq: message.seq,
    ok: !rejected,
    code: rejected ? 'INVALID_STATE' :
      (message.cmd === 'start_formal' ? 'ACCEPTED' : 'OK'),
    detail: 0,
    program_id: message.cmd === 'start_formal' ? 42 : undefined
  });
  if (message.cmd === 'hello') {
    emitMessage({
      v: 1,
      type: 'capabilities',
      max_frame: 2048,
      legacy: true,
      commands: ['hello', 'get_status', 'start_formal']
    });
  }
}

global.wx = {
  getStorageSync: () => storageSeq,
  setStorageSync: (key, value) => { storageSeq = value; },
  openBluetoothAdapter: options => callbackSuccess(options),
  onBLECharacteristicValueChange: callback => { valueListener = callback; },
  onBLEConnectionStateChange: callback => { connectionListener = callback; },
  createBLEConnection: options => {
    createConnectionCount++;
    callbackSuccess(options);
  },
  closeBLEConnection: options => callbackSuccess(options),
  getBLEDeviceServices: options => callbackSuccess(options, {
    services: [{ uuid: '0000FFF0-0000-1000-8000-00805F9B34FB' }]
  }),
  getBLEDeviceCharacteristics: options => callbackSuccess(options, {
    characteristics: [
      {
        uuid: '0000FFF1-0000-1000-8000-00805F9B34FB',
        properties: { write: true, writeNoResponse: true }
      },
      {
        uuid: '0000FFF2-0000-1000-8000-00805F9B34FB',
        properties: { read: true, notify: true }
      }
    ]
  }),
  notifyBLECharacteristicValueChange: options => callbackSuccess(options),
  getBLEDeviceRSSI: options => callbackSuccess(options, { RSSI: -44 }),
  writeBLECharacteristicValue: options => {
    const messages = deviceRx.push(new Uint8Array(options.value));
    callbackSuccess(options);
    messages.forEach(respondToRequest);
  },
  stopBluetoothDevicesDiscovery: options => callbackSuccess(options || {}),
  offBluetoothDeviceFound: callback => {
    if (!callback || callback === deviceFoundListener) deviceFoundListener = null;
  },
  onBluetoothDeviceFound: callback => { deviceFoundListener = callback; },
  startBluetoothDevicesDiscovery: options => {
    startDiscoveryCount++;
    callbackSuccess(options);
    setTimeout(() => {
      if (deviceFoundListener) {
        deviceFoundListener({
          devices: [{ deviceId: 'dev-1', name: 'JJTP-XIAOJING', RSSI: -44 }]
        });
      }
    }, 1);
  }
};

const ble = require('../miniprogram/utils/ble');

async function main() {
  const observed = [];
  ble.onDataReceived(message => observed.push(message));

  await assert.rejects(
    ble.connectDevice('undefined'),
    error => error.code === 'BLE_DEVICE_ID_INVALID'
  );
  assert.strictEqual(ble.getLastConnectDebug().source, 'connectDevice.reject');
  assert.strictEqual(ble.getLastConnectDebug().valid, false);
  await assert.rejects(
    ble.connectDevice('JJTP-XIAOJING'),
    error => error.code === 'BLE_DEVICE_ID_INVALID'
  );
  await assert.rejects(
    ble.connectDevice('device_001'),
    error => error.code === 'BLE_DEVICE_ID_INVALID'
  );

  const cancelledScan = ble.scanDevices(100);
  ble.stopScan();
  assert.deepStrictEqual(await cancelledScan, []);

  const scanOne = ble.scanDevices(20);
  const scanTwo = ble.scanDevices(20);
  assert.strictEqual(scanOne, scanTwo);
  const scanResult = await scanOne;
  assert.strictEqual(startDiscoveryCount, 1);
  assert.strictEqual(scanResult.length, 1);
  assert.strictEqual(scanResult[0].deviceId, 'dev-1');

  const [info, concurrentInfo] = await Promise.all([
    ble.connectDevice('dev-1'),
    ble.connectDevice('dev-1')
  ]);
  assert.strictEqual(info.serviceId.toUpperCase(),
    '0000FFF0-0000-1000-8000-00805F9B34FB');
  assert.strictEqual(info.RSSI, -44);
  assert.strictEqual(concurrentInfo.deviceId, 'dev-1');
  assert.strictEqual(createConnectionCount, 1);
  assert.strictEqual(requests[0].cmd, 'hello');
  assert.strictEqual(requests[0].v, 1);
  assert.strictEqual(requests[0].type, 'cmd');
  const createCountAfterFirstConnect = createConnectionCount;

  const reusedInfo = await ble.connectDevice('dev-1');
  assert.strictEqual(reusedInfo.deviceId, 'dev-1');
  assert.strictEqual(createConnectionCount, createCountAfterFirstConnect);

  const startAck = await ble.sendProtocolCommand('start_formal', {
    allow_uv: true,
    allow_dry: false
  }, { timeoutMs: 500, retries: 0 });
  assert.strictEqual(startAck.code, 'ACCEPTED');
  assert.strictEqual(startAck.program_id, 42);

  await assert.rejects(
    ble.sendProtocolCommand('skip_uv', {}, { timeoutMs: 500, retries: 0 }),
    error => error.code === 'INVALID_STATE'
  );

  const beforeRetry = requests.length;
  await ble.sendProtocolCommand('get_status', {}, { timeoutMs: 500, retries: 1 });
  const retryRequests = requests.slice(beforeRetry)
    .filter(message => message.cmd === 'get_status');
  assert.strictEqual(retryRequests.length, 2);
  assert.strictEqual(retryRequests[0].seq, retryRequests[1].seq);
  assert.deepStrictEqual(retryRequests[0], retryRequests[1]);

  emitMessage({
    v: 1,
    type: 'status',
    state: 2,
    phase: 0,
    progress: 0,
    program_id: 42
  });
  await notifyChain;
  assert.ok(observed.some(message =>
    message.type === 'status' && message.state === 2
  ));

  assert.strictEqual(typeof connectionListener, 'function');
  const snapshot = ble.getProtocolSnapshot();
  assert.strictEqual(snapshot.connected, true);
  assert.strictEqual(snapshot.protocolReady, true);

  await ble.disconnect();
  console.log('BLE_TRANSPORT_TESTS=19/19 PASS');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
