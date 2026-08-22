'use strict';

/**
 * ESP32-S3 BLE transport for the XiaoJing V1 application protocol.
 *
 * GATT:
 *   service FFF0
 *   RX FFF1: write / write-without-response
 *   TX FFF2: read / notify
 *   Credential RX FFF3: pairless write; ESP32 physical authorization required
 *
 * Application frames:
 *   request  {"v":1,"type":"cmd","seq":N,"cmd":"..."}
 *   response {"v":1,"type":"ack|nack","seq":N,...}
 *   status   {"v":1,"type":"status",...}
 *
 * A successful GATT write is NOT command acceptance. sendProtocolCommand()
 * resolves only after the matching application-level ACK is received.
 */

const protocol = require('./ble_protocol.js');

const DEVICE_NAME_PREFIX = 'JJTP';
const SERVICE_UUID = '0000FFF0-0000-1000-8000-00805F9B34FB';
const WRITE_CHAR_UUID = '0000FFF1-0000-1000-8000-00805F9B34FB';
const NOTIFY_CHAR_UUID = '0000FFF2-0000-1000-8000-00805F9B34FB';
const SECURE_WRITE_CHAR_UUID = '0000FFF3-0000-1000-8000-00805F9B34FB';
const SAFE_WRITE_CHUNK = 20;
const WRITE_GAP_MS = 20;
/* 单次 GATT 写入超时：个别机型/连接不稳时微信 writeBLECharacteristicValue
 * 的 fail 回调可能长期不触发，导致写链被这一帧永久卡住、后续所有命令
 * （含台架确认）全部阻塞。超时后主动 reject 断开写链，让重试能进行。 */
const WRITE_TIMEOUT_MS = 2000;
const DEFAULT_ACK_TIMEOUT_MS = 5000;
const DEFAULT_RETRIES = 2;
const MAX_RECONNECT_ATTEMPTS = 5;
const SEQ_STORAGE_KEY = 'xiaojing_ble_v1_seq';
const LAST_DEVICE_STORAGE_KEY = 'xiaojing_ble_v1_last_device';

let isScanning = false;
let activeScan = null;
let listenersInstalled = false;
let manualDisconnect = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let reconnectCallback = null;
let onDisconnectCallback = null;
let connectInFlight = null;
let connectInFlightDeviceId = '';
let writeChain = Promise.resolve();
let lastConnectDebug = null;

const messageListeners = [];
const pendingRequests = Object.create(null);
const frameAssembler = new protocol.JsonFrameAssembler(protocol.MAX_FRAME_BYTES);

const connection = {
  deviceId: '',
  serviceId: '',
  writeCharId: '',
  secureWriteCharId: '',
  notifyCharId: '',
  writeProperties: null,
  connected: false,
  protocolReady: false,
  lastCapabilities: null,
  lastStatus: null
};

function isConnectableDeviceId(deviceId) {
  if (typeof deviceId !== 'string') return false;
  const value = deviceId.trim();
  if (!value || value === 'undefined' || value === 'null') return false;
  if (value.startsWith(DEVICE_NAME_PREFIX)) return false;
  if (value.startsWith('device_')) return false;
  return true;
}

function rememberConnectDebug(source, deviceId, error) {
  lastConnectDebug = {
    source: source,
    deviceId: typeof deviceId === 'string' ? deviceId : String(deviceId),
    valid: isConnectableDeviceId(deviceId),
    errorCode: error && (error.code || error.errCode || error.errno || ''),
    errMsg: error && (error.errMsg || error.message || ''),
    at: Date.now()
  };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeUuid(value) {
  return String(value || '').toUpperCase();
}

function makeError(code, detail, message) {
  const error = new Error(message || code);
  error.code = code;
  error.detail = detail || 0;
  return error;
}

function wxPromise(invoke) {
  return new Promise((resolve, reject) => {
    invoke({
      success: resolve,
      fail: reject
    });
  });
}

function withTimeout(promise, ms, code, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(makeError(code, 0, message || code));
    }, ms);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
}

function openAdapter() {
  return wxPromise(callbacks => wx.openBluetoothAdapter(callbacks));
}

function rememberDevice(deviceId, deviceName) {
  if (!isConnectableDeviceId(deviceId)) return;
  try {
    const previous = wx.getStorageSync(LAST_DEVICE_STORAGE_KEY) || {};
    wx.setStorageSync(LAST_DEVICE_STORAGE_KEY, {
      deviceId: deviceId,
      deviceName: deviceName || previous.deviceName || '',
      at: Date.now()
    });
  } catch (error) {
    console.warn('[BLE] last device persistence unavailable:', error);
  }
}

function getRememberedDevice() {
  try {
    const value = wx.getStorageSync(LAST_DEVICE_STORAGE_KEY) || {};
    if (!isConnectableDeviceId(value.deviceId)) return null;
    return {
      deviceId: value.deviceId,
      deviceName: typeof value.deviceName === 'string' ? value.deviceName : '',
      at: Number(value.at) || 0
    };
  } catch (error) {
    return null;
  }
}

function allocateSequence() {
  let current = 0;
  try {
    current = Number(wx.getStorageSync(SEQ_STORAGE_KEY)) >>> 0;
  } catch (error) {
    current = 0;
  }
  if (current === 0) {
    current = Date.now() >>> 0;
  }
  current = (current + 1) >>> 0;
  if (current === 0) current = 1;
  try {
    wx.setStorageSync(SEQ_STORAGE_KEY, current);
  } catch (error) {
    console.warn('[BLE] sequence persistence unavailable:', error);
  }
  return current;
}

function splitBytes(bytes, chunkSize) {
  const chunks = [];
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    chunks.push(bytes.slice(offset, Math.min(offset + chunkSize, bytes.byteLength)));
  }
  return chunks;
}

function enqueueWrite(operation) {
  const result = writeChain.then(operation, operation);
  writeChain = result.catch(() => {});
  return result;
}

function writeChunk(deviceId, serviceId, characteristicId, bytes) {
  /* 超时守卫见 WRITE_TIMEOUT_MS：写回调挂起时在 2s 内 reject，写链不再被卡。 */
  return withTimeout(
    wxPromise(callbacks => wx.writeBLECharacteristicValue({
      deviceId: deviceId,
      serviceId: serviceId,
      characteristicId: characteristicId,
      value: protocol.arrayBufferFromBytes(bytes),
      success: callbacks.success,
      fail: callbacks.fail
    })),
    WRITE_TIMEOUT_MS,
    'WRITE_TIMEOUT',
    'BLE write did not complete within ' + WRITE_TIMEOUT_MS + 'ms'
  );
}

function writeFrameToCharacteristic(serialized, characteristicId) {
  if (!connection.connected || !connection.deviceId ||
      !connection.serviceId || !characteristicId) {
    return Promise.reject(makeError('BLE_NOT_CONNECTED'));
  }

  const deviceId = connection.deviceId;
  const serviceId = connection.serviceId;
  const chunks = splitBytes(protocol.encodeUtf8(serialized), SAFE_WRITE_CHUNK);

  return enqueueWrite(async () => {
    for (let i = 0; i < chunks.length; i++) {
      if (!connection.connected || connection.deviceId !== deviceId) {
        throw makeError('BLE_DISCONNECTED');
      }
      await writeChunk(deviceId, serviceId, characteristicId, chunks[i]);
      if (i + 1 < chunks.length) await delay(WRITE_GAP_MS);
    }
  });
}

function writeFrame(serialized) {
  return writeFrameToCharacteristic(serialized, connection.writeCharId);
}

function writeSecureFrame(serialized) {
  if (!connection.secureWriteCharId) {
    return Promise.reject(makeError('BLE_SECURE_CREDENTIALS_UNAVAILABLE'));
  }
  return writeFrameToCharacteristic(
    serialized, connection.secureWriteCharId);
}

function notifyMessage(message) {
  const snapshot = messageListeners.slice();
  snapshot.forEach(listener => {
    try {
      listener(message);
    } catch (error) {
      console.error('[BLE] message listener failed:', error);
    }
  });
}

function settlePending(message) {
  if ((message.type !== 'ack' && message.type !== 'nack' &&
       message.type !== 'credential_ack') ||
      !Number.isInteger(message.seq)) {
    return;
  }

  const entry = pendingRequests[message.seq];
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  delete pendingRequests[message.seq];

  if ((message.type === 'ack' || message.type === 'credential_ack') &&
      message.ok === true) {
    entry.resolve(message);
  } else {
    entry.reject(makeError(
      message.code || 'NACK',
      message.detail,
      `ESP32 rejected ${entry.command}: ${message.code || 'NACK'}`
    ));
  }
}

function processMessage(message) {
  if (!message || message.v !== protocol.PROTOCOL_VERSION ||
      typeof message.type !== 'string') {
    console.warn('[BLE] ignored non-V1 message:', message);
    return;
  }

  settlePending(message);
  if (message.type === 'capabilities') {
    connection.lastCapabilities = message;
    connection.protocolReady = true;
  } else if (message.type === 'status') {
    connection.lastStatus = message;
  }
  notifyMessage(message);
}

function handleCharacteristicValueChange(result) {
  if (!result || !result.value) return;
  if (connection.deviceId && result.deviceId !== connection.deviceId) return;
  if (connection.notifyCharId &&
      normalizeUuid(result.characteristicId) !== normalizeUuid(connection.notifyCharId)) {
    return;
  }

  try {
    const messages = frameAssembler.push(new Uint8Array(result.value));
    messages.forEach(processMessage);
  } catch (error) {
    console.error('[BLE] RX frame rejected:', error.message || error);
    frameAssembler.reset();
  }
}

function rejectAllPending(code) {
  Object.keys(pendingRequests).forEach(key => {
    const entry = pendingRequests[key];
    if (entry.timer) clearTimeout(entry.timer);
    entry.reject(makeError(code || 'BLE_DISCONNECTED'));
    delete pendingRequests[key];
  });
}

function clearConnectionDetails(keepDeviceId) {
  connection.connected = false;
  connection.protocolReady = false;
  connection.serviceId = '';
  connection.writeCharId = '';
  connection.secureWriteCharId = '';
  connection.notifyCharId = '';
  connection.writeProperties = null;
  connection.lastCapabilities = null;
  frameAssembler.reset();
  if (!keepDeviceId) connection.deviceId = '';
}

function handleConnectionStateChange(result) {
  if (!result || result.connected ||
      !connection.deviceId || result.deviceId !== connection.deviceId) {
    return;
  }

  const deviceId = connection.deviceId;
  clearConnectionDetails(true);
  rejectAllPending('BLE_DISCONNECTED');

  if (manualDisconnect) {
    manualDisconnect = false;
    clearConnectionDetails(false);
    return;
  }

  if (onDisconnectCallback) onDisconnectCallback({ reconnecting: true });
  autoReconnect(deviceId);
}

function ensureGlobalListeners() {
  if (listenersInstalled) return;
  wx.onBLECharacteristicValueChange(handleCharacteristicValueChange);
  wx.onBLEConnectionStateChange(handleConnectionStateChange);
  listenersInstalled = true;
}

function setReconnectCallbacks(onReconnect, onDisconnect) {
  reconnectCallback = typeof onReconnect === 'function' ? onReconnect : null;
  onDisconnectCallback = typeof onDisconnect === 'function' ? onDisconnect : null;
}

function clearReconnectState() {
  reconnectAttempts = 0;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function onDataReceived(callback) {
  if (typeof callback !== 'function') return () => {};
  if (messageListeners.indexOf(callback) < 0) messageListeners.push(callback);
  return () => offDataReceived(callback);
}

function offDataReceived(callback) {
  const index = messageListeners.indexOf(callback);
  if (index >= 0) messageListeners.splice(index, 1);
}

function scanDevices(timeout) {
  const scanTimeout = typeof timeout === 'number' ? timeout : 8000;
  ensureGlobalListeners();

  // One discovery session owns its listener and timeout. Returning the same
  // promise prevents an old scan timeout from removing a newer scan listener.
  if (activeScan) return activeScan.promise;

  const session = {
    foundDevices: [],
    handler: null,
    timer: null,
    settled: false,
    resolve: null,
    reject: null,
    promise: null
  };

  const cleanup = () => {
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    if (session.handler) {
      wx.offBluetoothDeviceFound(session.handler);
      session.handler = null;
    }
    wx.stopBluetoothDevicesDiscovery({});
    isScanning = false;
    if (activeScan === session) activeScan = null;
  };

  const finish = (error) => {
    if (session.settled) return;
    session.settled = true;
    cleanup();
    session.foundDevices.sort((left, right) => right.RSSI - left.RSSI);
    if (error) session.reject(error);
    else session.resolve(session.foundDevices.slice());
  };
  session.finish = finish;

  session.promise = new Promise((resolve, reject) => {
    session.resolve = resolve;
    session.reject = reject;

    openAdapter().catch(error => {
      if (error && error.errCode === 10000) return null;
      throw error;
    }).then(() => {
      if (session.settled) return;
      isScanning = true;

      session.handler = result => {
        (result.devices || []).forEach(device => {
          const name = device.name || device.localName || '';
          if (!name.startsWith(DEVICE_NAME_PREFIX)) return;
          if (!isConnectableDeviceId(device.deviceId)) return;
          if (session.foundDevices.some(item => item.deviceId === device.deviceId)) return;
          session.foundDevices.push({
            deviceId: device.deviceId,
            name: name,
            RSSI: device.RSSI,
            advertisData: device.advertisData
          });
        });
      };
      wx.onBluetoothDeviceFound(session.handler);

      wx.startBluetoothDevicesDiscovery({
        allowDuplicatesKey: false,
        success: () => {
          session.timer = setTimeout(() => finish(null), scanTimeout);
        },
        fail: error => finish(error)
      });
    }).catch(error => finish(error));
  });

  activeScan = session;
  return session.promise;
}

function stopScan() {
  if (activeScan && activeScan.finish) {
    activeScan.finish(null);
    return;
  }
  if (isScanning) wx.stopBluetoothDevicesDiscovery({});
  isScanning = false;
}

function resetAdapterForRecovery() {
  stopScan();
  clearReconnectState();
  manualDisconnect = true;
  rejectAllPending('BLE_ADAPTER_RESET');
  clearConnectionDetails(false);

  const closeAdapter = typeof wx.closeBluetoothAdapter === 'function'
    ? new Promise(resolve => wx.closeBluetoothAdapter({ complete: resolve }))
    : Promise.resolve();

  return closeAdapter
    .then(() => delay(350))
    .then(() => openAdapter())
    .finally(() => {
      manualDisconnect = false;
    });
}

function discoverGatt(deviceId) {
  return wxPromise(callbacks => wx.getBLEDeviceServices({
    deviceId: deviceId,
    success: callbacks.success,
    fail: callbacks.fail
  })).then(serviceResult => {
    const service = (serviceResult.services || []).find(item =>
      normalizeUuid(item.uuid) === normalizeUuid(SERVICE_UUID)
    );
    if (!service) throw makeError('BLE_SERVICE_NOT_FOUND');

    return wxPromise(callbacks => wx.getBLEDeviceCharacteristics({
      deviceId: deviceId,
      serviceId: service.uuid,
      success: callbacks.success,
      fail: callbacks.fail
    })).then(characteristicResult => {
      const characteristics = characteristicResult.characteristics || [];
      const writeCharacteristic = characteristics.find(item =>
        normalizeUuid(item.uuid) === normalizeUuid(WRITE_CHAR_UUID)
      );
      const notifyCharacteristic = characteristics.find(item =>
        normalizeUuid(item.uuid) === normalizeUuid(NOTIFY_CHAR_UUID)
      );
      const secureWriteCharacteristic = characteristics.find(item =>
        normalizeUuid(item.uuid) === normalizeUuid(SECURE_WRITE_CHAR_UUID)
      );

      if (!writeCharacteristic ||
          !(writeCharacteristic.properties.write ||
            writeCharacteristic.properties.writeNoResponse)) {
        throw makeError('BLE_WRITE_CHARACTERISTIC_INVALID');
      }
      if (!notifyCharacteristic ||
          !(notifyCharacteristic.properties.notify ||
            notifyCharacteristic.properties.indicate)) {
        throw makeError('BLE_NOTIFY_CHARACTERISTIC_INVALID');
      }

      return wxPromise(callbacks => wx.notifyBLECharacteristicValueChange({
        deviceId: deviceId,
        serviceId: service.uuid,
        characteristicId: notifyCharacteristic.uuid,
        state: true,
        success: callbacks.success,
        fail: callbacks.fail
      })).then(() => {
        connection.deviceId = deviceId;
        connection.serviceId = service.uuid;
        connection.writeCharId = writeCharacteristic.uuid;
        connection.secureWriteCharId =
          secureWriteCharacteristic && secureWriteCharacteristic.properties.write
            ? secureWriteCharacteristic.uuid : '';
        connection.notifyCharId = notifyCharacteristic.uuid;
        connection.writeProperties = writeCharacteristic.properties;
        connection.connected = true;
        connection.protocolReady = false;
        frameAssembler.reset();
        return {
          deviceId: deviceId,
          serviceId: service.uuid,
          writeCharId: writeCharacteristic.uuid,
          secureWriteCharId: connection.secureWriteCharId,
          notifyCharId: notifyCharacteristic.uuid,
          properties: writeCharacteristic.properties
        };
      });
    });
  });
}

function hasGattReadyFor(deviceId) {
  return connection.deviceId === deviceId &&
    connection.connected &&
    connection.serviceId &&
    connection.writeCharId &&
    connection.notifyCharId;
}

function makeConnectionInfo(extra) {
  const info = {
    deviceId: connection.deviceId,
    serviceId: connection.serviceId,
    writeCharId: connection.writeCharId,
    secureWriteCharId: connection.secureWriteCharId,
    notifyCharId: connection.notifyCharId,
    properties: connection.writeProperties
  };
  if (extra && typeof extra === 'object') {
    Object.keys(extra).forEach(key => { info[key] = extra[key]; });
  }
  return info;
}

function requestAttempt(entry) {
  entry.attempts++;
  const writer = entry.secure ? writeSecureFrame : writeFrame;
  writer(entry.serialized).then(() => {
    if (pendingRequests[entry.seq] !== entry) return;
    entry.timer = setTimeout(() => {
      if (pendingRequests[entry.seq] !== entry) return;
      entry.timer = null;
      if (entry.attempts <= entry.maxRetries) {
        requestAttempt(entry);
      } else {
        delete pendingRequests[entry.seq];
        entry.reject(makeError(
          'ACK_TIMEOUT',
          0,
          `No ACK for ${entry.command} after ${entry.attempts} attempts`
        ));
      }
    }, entry.timeoutMs);
  }).catch(error => {
    if (pendingRequests[entry.seq] !== entry) return;
    if (entry.attempts <= entry.maxRetries && connection.connected) {
      setTimeout(() => requestAttempt(entry), 100);
    } else {
      delete pendingRequests[entry.seq];
      entry.reject(error);
    }
  });
}

function sendCredentialCommand(command, payload, options) {
  const opts = options || {};
  if (!connection.connected)
    return Promise.reject(makeError('BLE_NOT_CONNECTED'));
  if (!connection.secureWriteCharId)
    return Promise.reject(makeError('BLE_SECURE_CREDENTIALS_UNAVAILABLE'));
  const seq = allocateSequence();
  const message = Object.assign({
    v: protocol.PROTOCOL_VERSION,
    seq: seq,
    cmd: command
  }, payload || {});
  const serialized = JSON.stringify(message);
  if (protocol.encodeUtf8(serialized).byteLength > 1024) {
    return Promise.reject(makeError('BLE_CREDENTIAL_FRAME_TOO_LARGE'));
  }
  return new Promise((resolve, reject) => {
    const entry = {
      seq: seq,
      command: command,
      serialized: serialized,
      secure: true,
      attempts: 0,
      /* Secret writes are not retried automatically: the first write may
       * already have committed even if its notification was lost. */
      maxRetries: 0,
      timeoutMs: Number.isInteger(opts.timeoutMs) ? opts.timeoutMs : 10000,
      timer: null,
      resolve: resolve,
      reject: reject
    };
    pendingRequests[seq] = entry;
    requestAttempt(entry);
  });
}

function sendProtocolCommand(command, payload, options) {
  const opts = options || {};
  if (!connection.connected) return Promise.reject(makeError('BLE_NOT_CONNECTED'));

  const seq = allocateSequence();
  const message = protocol.createCommand(seq, command, payload || {});
  const serialized = JSON.stringify(message);
  if (protocol.encodeUtf8(serialized).byteLength > protocol.MAX_FRAME_BYTES) {
    return Promise.reject(makeError('BLE_FRAME_TOO_LARGE'));
  }

  return new Promise((resolve, reject) => {
    const entry = {
      seq: seq,
      command: command,
      serialized: serialized,
      attempts: 0,
      maxRetries: Number.isInteger(opts.retries) ? opts.retries : DEFAULT_RETRIES,
      timeoutMs: Number.isInteger(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_ACK_TIMEOUT_MS,
      timer: null,
      resolve: resolve,
      reject: reject
    };
    pendingRequests[seq] = entry;
    requestAttempt(entry);
  });
}

function getProtocolSnapshot() {
  return {
    connected: connection.connected,
    protocolReady: connection.protocolReady,
    deviceId: connection.deviceId,
    serviceId: connection.serviceId,
    writeCharId: connection.writeCharId,
    secureWriteCharId: connection.secureWriteCharId,
    notifyCharId: connection.notifyCharId,
    capabilities: connection.lastCapabilities,
    status: connection.lastStatus
  };
}

function connectAndHandshake(deviceId) {
  ensureGlobalListeners();
  return discoverGatt(deviceId).then(info =>
    sendProtocolCommand('hello', {}, { timeoutMs: 3000, retries: 1 })
      .then(ack => {
        connection.protocolReady = true;
        info.protocolAck = ack;
        return info;
      })
  );
}

function trackConnectOperation(deviceId, operation) {
  connectInFlightDeviceId = deviceId;
  connectInFlight = operation.finally(() => {
    if (connectInFlightDeviceId === deviceId) {
      connectInFlight = null;
      connectInFlightDeviceId = '';
    }
  });
  return connectInFlight;
}

function connectDevice(deviceId, internalOptions) {
  const options = internalOptions || {};
  if (!isConnectableDeviceId(deviceId)) {
    rememberConnectDebug('connectDevice.reject', deviceId, {
      code: 'BLE_DEVICE_ID_INVALID'
    });
    return Promise.reject(makeError('BLE_DEVICE_ID_INVALID'));
  }
  if (connectInFlight) {
    if (connectInFlightDeviceId === deviceId) return connectInFlight;
    return connectInFlight.catch(() => null)
      .then(() => connectDevice(deviceId, internalOptions));
  }

  rememberConnectDebug(options.reconnect ? 'autoReconnect.connect' : 'connectDevice',
    deviceId, null);
  ensureGlobalListeners();
  if (!options.reconnect) clearReconnectState();
  manualDisconnect = false;

  if (hasGattReadyFor(deviceId) && connection.protocolReady) {
    return wxPromise(callbacks => wx.getBLEDeviceRSSI({
      deviceId: deviceId,
      success: callbacks.success,
      fail: () => callbacks.success({ RSSI: -100 })
    })).then(result => makeConnectionInfo({ RSSI: result.RSSI }));
  }

  if (hasGattReadyFor(deviceId)) {
    const handshakeOperation = connectAndHandshake(deviceId)
      .then(info => wxPromise(callbacks => wx.getBLEDeviceRSSI({
        deviceId: deviceId,
        success: callbacks.success,
        fail: () => callbacks.success({ RSSI: -100 })
      })).then(result => {
        info.RSSI = result.RSSI;
        return info;
      }));
    return trackConnectOperation(deviceId, handshakeOperation);
  }

  const previousDeviceId = connection.deviceId &&
    connection.deviceId !== deviceId ? connection.deviceId : '';
  const closePrevious = previousDeviceId
    ? wxPromise(callbacks => wx.closeBLEConnection({
        deviceId: previousDeviceId,
        complete: callbacks.success
      })).then(() => {
        if (connection.deviceId === previousDeviceId) clearConnectionDetails(false);
      })
    : Promise.resolve();

  const operation = closePrevious
    .then(() => openAdapter())
    .then(() => wxPromise(callbacks => wx.createBLEConnection({
      deviceId: deviceId,
      timeout: 7000,
      success: callbacks.success,
      fail: callbacks.fail
    })))
    .then(() => {
      connection.deviceId = deviceId;
      connection.connected = true;
      return delay(120);
    })
    .then(() => connectAndHandshake(deviceId))
    .then(info => wxPromise(callbacks => wx.getBLEDeviceRSSI({
      deviceId: deviceId,
      success: callbacks.success,
      fail: () => callbacks.success({ RSSI: -100 })
    })).then(result => {
      info.RSSI = result.RSSI;
      rememberDevice(deviceId, '');
      return info;
    }))
    .catch(error => {
      rememberConnectDebug('connectDevice.fail', deviceId, error);
      try {
        wx.closeBLEConnection({ deviceId: deviceId });
      } catch (closeError) {
        console.warn('[BLE] cleanup after handshake failure failed:', closeError);
      }
      clearConnectionDetails(false);
      throw error;
    });

  return trackConnectOperation(deviceId, operation);
}

function autoReconnect(deviceId) {
  if (!isConnectableDeviceId(deviceId) || manualDisconnect || reconnectTimer) {
    if (!isConnectableDeviceId(deviceId)) {
      rememberConnectDebug('autoReconnect.reject', deviceId, {
        code: 'BLE_DEVICE_ID_INVALID'
      });
      if (onDisconnectCallback) onDisconnectCallback({ reconnecting: false });
    }
    return;
  }
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    reconnectAttempts = 0;
    if (onDisconnectCallback) onDisconnectCallback({ reconnecting: false });
    return;
  }

  reconnectAttempts++;
  const waitMs = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 10000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectDevice(deviceId, { reconnect: true })
      .then(info => {
        clearReconnectState();
        if (reconnectCallback) reconnectCallback(info);
      })
      .catch(error => {
        rememberConnectDebug('autoReconnect.fail', deviceId, error);
        clearConnectionDetails(true);
        autoReconnect(deviceId);
      });
  }, waitMs);
}

function disconnect() {
  clearReconnectState();
  manualDisconnect = true;
  const deviceId = connection.deviceId;
  rejectAllPending('BLE_DISCONNECTED');
  clearConnectionDetails(false);
  if (!deviceId) return Promise.resolve();
  return wxPromise(callbacks => wx.closeBLEConnection({
    deviceId: deviceId,
    success: callbacks.success,
    fail: callbacks.fail
  })).catch(error => {
    console.warn('[BLE] close connection failed:', error);
  });
}

/* 诊断负向测试专用：关闭当前 BLE 连接但保留自动重连（不置 manualDisconnect、
 * 不清重连状态），使 onBLEConnectionStateChange 走 handleConnectionStateChange
 * → autoReconnect。仅供开发测试区使用；生产流程不会调用。 */
function disconnectForDiagnostic() {
  const deviceId = connection.deviceId;
  if (!deviceId) return Promise.resolve();
  return wxPromise(callbacks => wx.closeBLEConnection({
    deviceId: deviceId,
    success: callbacks.success,
    fail: callbacks.fail
  })).catch(error => {
    console.warn('[BLE] diagnostic disconnect failed:', error);
  });
}

function getConnectedDeviceId() {
  return connection.deviceId;
}

function getLastConnectDebug() {
  return lastConnectDebug ? { ...lastConnectDebug } : null;
}

function buildFormalPayload(orderData) {
  const steps = orderData && orderData.steps ? orderData.steps : {};
  const dry = steps.dry || {};
  return {
    // 固件契约字段就是 allow_uv；显式发送，绝不依赖固件缺省值。
    allow_uv: !!(orderData && orderData.allowUv === true),
    allow_dry: dry.enabled === true && Number(dry.count) > 0
  };
}

module.exports = {
  DEVICE_NAME_PREFIX,
  SERVICE_UUID,
  WRITE_CHAR_UUID,
  NOTIFY_CHAR_UUID,
  SECURE_WRITE_CHAR_UUID,
  scanDevices,
  stopScan,
  resetAdapterForRecovery,
  connectDevice,
  disconnect,
  disconnectForDiagnostic,
  sendProtocolCommand,
  sendCredentialCommand,
  onDataReceived,
  offDataReceived,
  setReconnectCallbacks,
  clearReconnectState,
  isConnectableDeviceId,
  getConnectedDeviceId,
  getLastConnectDebug,
  rememberDevice,
  getRememberedDevice,
  getProtocolSnapshot,
  buildFormalPayload
};
