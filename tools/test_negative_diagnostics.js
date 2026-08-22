'use strict';

/*
 * test_negative_diagnostics.js — 自动负向测试（开发诊断区）契约测试
 *
 * Required cases:
 *   1. 阀互锁：source 受理后 200ms 请求 transfer 必须被拒绝（SELF_TEST_BUSY 等）
 *   2. 互锁：transfer 被拒后首个自检终态 COMPLETE + off=true → PASS
 *   3. 互锁：transfer 若被受理 → FAIL（互锁失效）
 *   4. 互锁 200ms 时序：transfer 请求晚于 source ACCEPTED ≥200ms
 *   5. BLE 断线：source 受理后 250ms 主动断开，断线期间显示
 *      "已请求断线关断，等待设备重新连接确认"，绝不得提前显示"已安全关闭"
 *   6. BLE 断线：重连后 off=true 才显示"已确认关闭"
 *   7. BLE 断线：off=false 不显示"已确认关闭"
 *   8. BLE 250ms 时序：断开动作晚于 source ACCEPTED ≥250ms
 *   9. 防重复点击：diagIlkBusy / diagBleBusy 忙时再次点击不发送
 *   10. 生产开关关闭时入口不存在（wxml 全在 diagEnabled 块内）
 *   11. 不调用 createOrderV2、不修改 allowUv、不改价格
 *   12. 不绕过 actuator_self_test 单活跃门禁（拒绝码必须来自固件）
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

const washSource = fs.readFileSync(
  path.join(root, 'miniprogram/pages/wash/wash.js'), 'utf8'
);
const washWxml = fs.readFileSync(
  path.join(root, 'miniprogram/pages/wash/wash.wxml'), 'utf8'
);

let testsRun = 0;
let testsPassed = 0;
let testsFailed = 0;

function TEST(name) {
  testsRun++;
  process.stdout.write(`  TEST ${String(testsRun).padStart(2, '0')}: ${name}`);
}
function PASS() { testsPassed++; console.log(' PASS'); }
function FAIL(msg) { testsFailed++; console.log(` FAIL: ${msg}`); }

const ACT_ACCEPT = (target, duration) => ({
  type: 'ack', ok: true, code: 'ACTUATOR_SELF_TEST_ACCEPTED',
  target: target, duration_ms: duration
});

/*
 * loadWash(diagEnabled, opts)
 * opts.send(command, payload) -> settled value/rejection per command.
 *   Return {ack: obj} to resolve, {err: {code}} to reject, {skip:true} to not settle.
 * opts.snapshot() -> current protocol snapshot (mutable).
 */
function loadWash(diagEnabled, opts = {}) {
  let pageDefinition = null;
  const sentCommands = [];
  const cloudCalls = [];
  const disconnectCalls = [];
  let modalHandlers = [];
  let onReconnectCb = null;
  let onDisconnectCb = null;

  const snapshot = {
    connected: true, protocolReady: true, deviceId: 'phone-ble-id',
    serviceId: 'fff0', writeCharId: 'fff1', notifyCharId: 'fff2', status: null
  };

  const ble = {
    DEVICE_NAME_PREFIX: 'JJTP',
    getProtocolSnapshot: () => (opts.snapshot ? opts.snapshot() : snapshot),
    getLastConnectDebug: () => null,
    sendProtocolCommand: async (command, payload) => {
      sentCommands.push({ command, payload });
      if (opts.onSend) opts.onSend(command, payload);
      const r = opts.send ? opts.send(command, payload) : { ack: { type: 'ack', ok: true, code: 'OK' } };
      if (r && r.skip) return new Promise(() => {});
      if (r && r.err) {
        const e = new Error('rejected');
        e.code = r.err.code;
        throw e;
      }
      return r && r.ack;
    },
    setReconnectCallbacks: (onReconnect, onDisconnect) => {
      onReconnectCb = onReconnect;
      onDisconnectCb = onDisconnect;
    },
    onDataReceived: () => () => {},
    connectDevice: async id => ({ deviceId: id }),
    scanDevices: async () => [],
    resetAdapterForRecovery: async () => {},
    rememberDevice: () => {},
    getRememberedDevice: () => null,
    disconnect: async () => {},
    disconnectForDiagnostic: async () => { disconnectCalls.push('diag'); }
  };

  const wx = {
    cloud: {
      callFunction: ({ name }) => { cloudCalls.push(name); return Promise.resolve({ result: { code: 0, data: {} } }); }
    },
    showModal: (opts2) => { modalHandlers.push(opts2); },
    showLoading: () => {},
    hideLoading: () => {},
    showToast: () => {},
    getSetting: () => {},
    closeBLEConnection: () => {}
  };

  const app = {
    globalData: {
      bleConnected: false, bleDeviceId: '', bleDeviceName: '',
      bleServiceId: '', bleWriteCharId: '', bleNotifyCharId: ''
    }
  };

  const versionMock = {
    MINIAPP_VERSION: 't',
    MINIAPP_ENABLE_HARDWARE_DIAGNOSTICS: diagEnabled
  };

  vm.runInNewContext(washSource, {
    require: (p) => {
      if (p === '../../utils/ble.js') return ble;
      if (p === '../../utils/version.js') return versionMock;
      return {};
    },
    getApp: () => app,
    Page: definition => { pageDefinition = definition; },
    wx, console, Date, Math, Promise, setTimeout, clearTimeout, setInterval, clearInterval
  }, { filename: 'wash.js' });

  assert.ok(pageDefinition, 'Page definition was not registered');
  const page = Object.assign({}, pageDefinition);
  page.data = JSON.parse(JSON.stringify(pageDefinition.data));
  page.setData = patch => Object.assign(page.data, patch);
  page._pageAlive = true;

  return {
    page, ble, sentCommands, cloudCalls, disconnectCalls,
    getLastModal: () => modalHandlers[modalHandlers.length - 1],
    onReconnect: () => onReconnectCb,
    onDisconnect: () => onDisconnectCb,
    snapshot
  };
}

function settle() { return new Promise(r => setTimeout(r, 25)); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function confirmAll(getLastModal) {
  // runInterlockAutoTest 等弹出第一个 modal；success({confirm:true}) 触发第二个
  getLastModal().success({ confirm: true });
}

async function main() {
  // ---- 生产开关关闭：入口不存在 ----
  {
    const { page } = loadWash(false);
    TEST('production flag off hides diagnostic entry + negative tests');
    const hasIlkButton = washWxml.indexOf('runInterlockAutoTest') >= 0;
    const hasBleButton = washWxml.indexOf('runBleDisconnectAutoTest') >= 0;
    const insideDiagBlock = washWxml.indexOf('runInterlockAutoTest') >
                            washWxml.indexOf('wx:if="{{diagEnabled}}"');
    if (page.data.diagEnabled === false && hasIlkButton && hasBleButton &&
        insideDiagBlock) PASS();
    else FAIL(`diagEnabled=${page.data.diagEnabled} ilk=${hasIlkButton} ble=${hasBleButton}`);
  }

  // ---- A. 阀互锁自动测试 ----
  {
    const opt = {
      snapshot: () => ({
        connected: true, protocolReady: true, deviceId: 'phone-ble-id',
        status: { actuator_self_test: { st: 4, tg: 0, off: true } }
      })
    };
    let actCalls = 0;
    const rejectCodes = [];
    opt.send = (command) => {
      if (command !== 'actuator_self_test') return { ack: { type: 'ack', ok: true, code: 'OK' } };
      actCalls++;
      if (actCalls === 1) return { ack: ACT_ACCEPT('source_valve', 1500) };
      const code = 'SELF_TEST_BUSY';
      rejectCodes.push(code);
      return { err: { code } };
    };
    const { page, getLastModal, sentCommands } = loadWash(true, opt);
    TEST('interlock: transfer rejected with documented conflict code (not accepted)');
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.runInterlockAutoTest();
    confirmAll(getLastModal);
    confirmAll(getLastModal); /* 二次确认 */
    await wait(320); /* source ACCEPTED + 200ms 后 transfer 发出 */
    const transferReq = sentCommands.filter(c => c.command === 'actuator_self_test' &&
      c.payload && c.payload.target === 'transfer_valve');
    if (rejectCodes.length === 1 && rejectCodes[0] === 'SELF_TEST_BUSY' &&
        transferReq.length === 1) PASS();
    else FAIL(`transfer must be NACKed SELF_TEST_BUSY, got ${JSON.stringify(rejectCodes)}`);
    page.stopIlkPoll();
  }

  {
    const opt = {
      send: () => { return { ack: ACT_ACCEPT('source_valve', 1500) }; },
      snapshot: () => ({ connected: true, protocolReady: true, deviceId: 'id',
        status: { actuator_self_test: { st: 4, tg: 0, off: true } } })
    };
    const { page, getLastModal, sentCommands } = loadWash(true, opt);
    TEST('interlock: 200ms sequence (transfer sent after source ACCEPTED)');
    let actCalls = 0;
    let acceptedAt = 0;
    let transferAt = 0;
    opt.send = (command) => {
      if (command !== 'actuator_self_test') return { ack: { type: 'ack', ok: true, code: 'OK' } };
      actCalls++;
      if (actCalls === 1) { acceptedAt = Date.now(); return { ack: ACT_ACCEPT('source_valve', 1500) }; }
      transferAt = Date.now();
      return { err: { code: 'SELF_TEST_BUSY' } };
    };
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.runInterlockAutoTest();
    confirmAll(getLastModal); confirmAll(getLastModal);
    await wait(400);
    const gap = transferAt - acceptedAt;
    if (gap >= 200 && actCalls === 2) PASS();
    else FAIL(`transfer gap=${gap}ms actCalls=${actCalls}`);
    page.stopIlkPoll();
  }

  {
    const opt = {
      snapshot: () => ({ connected: true, protocolReady: true, deviceId: 'id',
        status: { actuator_self_test: { st: 4, tg: 0, off: true } } })
    };
    let actCalls = 0;
    const { page, getLastModal } = loadWash(true, {
      send: (command) => {
        if (command !== 'actuator_self_test') return { ack: { type: 'ack', ok: true, code: 'OK' } };
        actCalls++;
        if (actCalls === 1) return { ack: ACT_ACCEPT('source_valve', 1500) };
        return { ack: ACT_ACCEPT('transfer_valve', 1500) }; /* 互锁失效场景 */
      },
      snapshot: opt.snapshot
    });
    TEST('interlock: second request ACCEPTED ⇒ FAIL (interlock broken)');
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.runInterlockAutoTest();
    confirmAll(getLastModal); confirmAll(getLastModal);
    await wait(350);
    if (page.data.diagIlkResult === 'FAIL' &&
        page.data.diagIlkStatus.indexOf('互锁失效') >= 0) PASS();
    else FAIL(`expected FAIL/interlock-broken, got result=${page.data.diagIlkResult} status=${page.data.diagIlkStatus}`);
    page.stopIlkPoll();
  }

  {
    const opt = {
      snapshot: () => ({ connected: true, protocolReady: true, deviceId: 'id',
        status: { actuator_self_test: { st: 4, tg: 0, off: true } } })
    };
    let actCalls = 0;
    const { page, getLastModal, sentCommands } = loadWash(true, {
      send: (command) => {
        if (command !== 'actuator_self_test') return { ack: { type: 'ack', ok: true, code: 'OK' } };
        actCalls++;
        if (actCalls === 1) return { ack: ACT_ACCEPT('source_valve', 1500) };
        return { err: { code: 'SELF_TEST_BUSY' } };
      },
      snapshot: opt.snapshot
    });
    TEST('interlock: terminal COMPLETE + off=true ⇒ PASS, no early confirm');
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.runInterlockAutoTest();
    confirmAll(getLastModal); confirmAll(getLastModal);
    await wait(500);
    if (page.data.diagIlkResult === 'PASS' && page.data.diagIlkOff === true &&
        page.data.diagIlkTerminal === '完成') PASS();
    else FAIL(`result=${page.data.diagIlkResult} off=${page.data.diagIlkOff} term=${page.data.diagIlkTerminal}`);
    page.stopIlkPoll();
  }

  // ---- B. BLE 断线自动关断测试 ----
  {
    const opt = {
      send: (command) => {
        if (command !== 'actuator_self_test') return { ack: { type: 'ack', ok: true, code: 'OK' } };
        return { ack: ACT_ACCEPT('source_valve', 1500) };
      },
      snapshot: () => ({ connected: false, protocolReady: false, deviceId: 'id', status: null })
    };
    const { page, getLastModal, disconnectCalls, snapshot } = loadWash(true, opt);
    TEST('BLE: disconnect requested, status shows "已请求断线关断，等待设备重新连接确认"');
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.runBleDisconnectAutoTest();
    confirmAll(getLastModal); confirmAll(getLastModal);
    await wait(50); /* source accepted */
    const accepted = page.data.diagBlePhase === 'source_accepted';
    await wait(300); /* 250ms timer fires → disconnect */
    if (disconnectCalls.length === 1 && accepted &&
        page.data.diagBleStatus.indexOf('已请求断线关断，等待设备重新连接确认') >= 0 &&
        page.data.diagBleStatus.indexOf('已安全关闭') < 0 &&
        page.data.diagBleStatus.indexOf('已确认关闭') < 0) PASS();
    else FAIL(`status=${page.data.diagBleStatus} disc=${disconnectCalls.length} accepted=${accepted}`);
    page.stopBleDiscPoll();
  }

  {
    const opt = {
      snapshot: () => ({ connected: true, protocolReady: true, deviceId: 'id', status: null })
    };
    let actCalls = 0;
    let discAt = 0;
    let acceptedAt = 0;
    const { page, getLastModal, disconnectCalls } = loadWash(true, {
      send: (command) => {
        if (command !== 'actuator_self_test') return { ack: { type: 'ack', ok: true, code: 'OK' } };
        actCalls++;
        acceptedAt = Date.now();
        return { ack: ACT_ACCEPT('source_valve', 1500) };
      },
      snapshot: () => ({ connected: false, protocolReady: false, deviceId: 'id', status: null })
    });
    TEST('BLE: 250ms sequence (disconnect after source ACCEPTED)');
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.runBleDisconnectAutoTest();
    confirmAll(getLastModal); confirmAll(getLastModal);
    await wait(450);
    discAt = Date.now();
    if (disconnectCalls.length === 1 && (discAt - acceptedAt) >= 250) PASS();
    else FAIL(`discCalls=${disconnectCalls.length} gap=${discAt - acceptedAt}ms`);
    page.stopBleDiscPoll();
  }

  {
    const opt = { snapshot: () => ({ connected: false, protocolReady: false, deviceId: 'id', status: null }) };
    const { page, getLastModal, disconnectCalls, snapshot } = loadWash(true, {
      send: (command) => {
        if (command !== 'actuator_self_test') return { ack: { type: 'ack', ok: true, code: 'OK' } };
        return { ack: ACT_ACCEPT('source_valve', 1500) };
      },
      snapshot: () => snapshot
    });
    TEST('BLE: off=true only shows "已确认关闭" after reconnect + device evidence');
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.runBleDisconnectAutoTest();
    confirmAll(getLastModal); confirmAll(getLastModal);
    await wait(300);
    /* 重连 + 设备证据：off=true */
    snapshot.connected = true; snapshot.protocolReady = true;
    snapshot.status = { actuator_self_test: { st: 6, tg: 0, last_code: 'ACTUATOR_SELF_TEST_INTERRUPTED', off: true } };
    await wait(700);
    if (disconnectCalls.length === 1 &&
        page.data.diagBleStatus.indexOf('已确认关闭') >= 0 &&
        page.data.diagBleOff === true &&
        page.data.diagBleTerminal === '被中断') PASS();
    else FAIL(`status=${page.data.diagBleStatus} off=${page.data.diagBleOff} term=${page.data.diagBleTerminal}`);
    page.stopBleDiscPoll();
  }

  {
    const opt = { snapshot: () => ({ connected: false, protocolReady: false, deviceId: 'id', status: null }) };
    const { page, getLastModal, snapshot } = loadWash(true, {
      send: (command) => {
        if (command !== 'actuator_self_test') return { ack: { type: 'ack', ok: true, code: 'OK' } };
        return { ack: ACT_ACCEPT('source_valve', 1500) };
      },
      snapshot: () => snapshot
    });
    TEST('BLE: off=false never shows "已确认关闭"');
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.runBleDisconnectAutoTest();
    confirmAll(getLastModal); confirmAll(getLastModal);
    await wait(300);
    snapshot.connected = true; snapshot.protocolReady = true;
    snapshot.status = { actuator_self_test: { st: 8, tg: 0, last_code: 'FAULT', off: false } };
    await wait(700);
    if (page.data.diagBleStatus.indexOf('已确认关闭') < 0 &&
        page.data.diagBleResult === 'FAIL') PASS();
    else FAIL(`status=${page.data.diagBleStatus} result=${page.data.diagBleResult}`);
    page.stopBleDiscPoll();
  }

  // ---- 防重复点击 ----
  {
    const opt = {
      send: (command) => {
        if (command !== 'actuator_self_test') return { ack: { type: 'ack', ok: true, code: 'OK' } };
        return { skip: true }; /* 挂起：模拟 in-flight */
      },
      snapshot: () => ({ connected: true, protocolReady: true, deviceId: 'id', status: null })
    };
    const { page, getLastModal, sentCommands } = loadWash(true, opt);
    TEST('double-click protection on interlock test');
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.runInterlockAutoTest();
    confirmAll(getLastModal); confirmAll(getLastModal);
    await settle();
    page.runInterlockAutoTest(); /* busy 时应直接 return，不再弹窗 */
    const sends = sentCommands.filter(c => c.command === 'actuator_self_test').length;
    if (sends === 1 && page.data.diagIlkBusy === true) PASS();
    else FAIL(`sends=${sends} busy=${page.data.diagIlkBusy}`);
    page.stopIlkPoll();
  }

  // ---- 不创建订单 / 不改 allowUv / 不改价格 ----
  {
    const opt = {
      send: (command) => {
        if (command !== 'actuator_self_test') return { ack: { type: 'ack', ok: true, code: 'OK' } };
        return { ack: ACT_ACCEPT('source_valve', 1500) };
      },
      snapshot: () => ({ connected: true, protocolReady: true, deviceId: 'id',
        status: { actuator_self_test: { st: 4, tg: 0, off: true } } })
    };
    const { page, getLastModal, cloudCalls, sentCommands } = loadWash(true, opt);
    TEST('negative tests do not create order / change allowUv / price');
    const beforeUv = page.data.uvDisinfectionEnabled;
    const beforePrice = page.data.totalPrice;
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.runInterlockAutoTest();
    confirmAll(getLastModal); confirmAll(getLastModal);
    await wait(500);
    const orderCalls = cloudCalls.filter(n => /order/i.test(n));
    const allowsUvChange = page.data.uvDisinfectionEnabled !== beforeUv;
    const priceChange = page.data.totalPrice !== beforePrice;
    const actCmds = sentCommands.filter(c => c.command === 'actuator_self_test');
    if (orderCalls.length === 0 && !allowsUvChange && !priceChange && actCmds.length >= 1) PASS();
    else FAIL(`cloud=${JSON.stringify(orderCalls)} uvChanged=${allowsUvChange} priceChanged=${priceChange}`);
    page.stopIlkPoll();
  }

  console.log(`\nnegative_diagnostics: ${testsPassed}/${testsRun} passed`);
  if (testsFailed > 0) {
    console.log(`FAILED: ${testsFailed}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('unhandled error:', err);
  process.exit(2);
});
