'use strict';

/*
 * test_uv_selftest_flow.js — UV 灯安全自检（开发诊断）契约测试
 *
 * 12 required cases:
 *   1. 开发入口默认折叠
 *   2. 未确认风险弹窗不发送命令
 *   3. 二次确认后发送 uv_self_test
 *   4. payload 不包含任意 duration
 *   5. 重复点击被锁定
 *   6. ACCEPTED 显示运行中
 *   7. COMPLETE 显示已自动关闭
 *   8. 每个拒绝 reason 有用户可读文案
 *   9. BLE 断开显示状态未知
 *   10. 不调用 createOrderV2
 *   11. 不修改 allowUv
 *   12. 正式发布开关关闭时入口不可见
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
const versionSource = fs.readFileSync(
  path.join(root, 'miniprogram/utils/version.js'), 'utf8'
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

function loadWash(diagEnabled, override = {}) {
  let pageDefinition = null;
  const sentCommands = [];
  const cloudCalls = [];
  let modalHandler = null;

  const ble = {
    DEVICE_NAME_PREFIX: 'JJTP',
    getProtocolSnapshot: () => override.protocolSnapshot || {
      connected: true, protocolReady: true, deviceId: 'phone-ble-id',
      serviceId: 'fff0', writeCharId: 'fff1', notifyCharId: 'fff2', status: null
    },
    getLastConnectDebug: () => null,
    sendProtocolCommand: async (command, payload) => {
      sentCommands.push({ command, payload });
      if (override.onSend) override.onSend(command, payload);
      if (command === 'uv_self_test') {
        if (override.selftestReject) {
          const err = new Error('rejected');
          err.code = override.selftestReject;
          return Promise.reject(err);
        }
        return Promise.resolve({ type: 'ack', ok: true, code: 'UV_SELF_TEST_ACCEPTED', duration_ms: 3000 });
      }
      return Promise.resolve({ type: 'ack', ok: true, code: 'OK' });
    },
    setReconnectCallbacks: (onReconnect, onState) => {
      override.onState = onState;
      if (onReconnect) override.onReconnect = onReconnect;
    },
    onDataReceived: () => () => {},
    connectDevice: async id => ({ deviceId: id }),
    scanDevices: async () => [],
    resetAdapterForRecovery: async () => {},
    rememberDevice: () => {},
    getRememberedDevice: () => null,
    disconnect: async () => {}
  };

  const wx = {
    cloud: {
      callFunction: ({ name }) => {
        cloudCalls.push(name);
        return Promise.resolve({ result: { code: 0, data: {} } });
      }
    },
    showModal: (opts) => { modalHandler = opts; },
    showLoading: () => {},
    hideLoading: () => {},
    showToast: () => {},
    getSetting: () => {}
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
    page,
    ble,
    sentCommands,
    cloudCalls,
    modalHandler,
    getLastModal: () => modalHandler
  };
}

function settle() { return new Promise(r => setTimeout(r, 20)); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  {
    const { page, getLastModal } = loadWash(true);
    TEST('dev entry is collapsed by default');
    if (page.data.diagExpanded === false && page.data.diagEnabled === true) PASS();
    else FAIL('diagExpanded must default false');
  }

  {
    const { page, getLastModal, ble, sentCommands } = loadWash(true);
    TEST('unconfirmed risk modal does not send');
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.runUvSelfTest();
    const modal = getLastModal();
    if (modal) modal.success({ confirm: false });
    await settle();
    if (sentCommands.length === 0) PASS();
    else FAIL(`command sent without confirmation: ${JSON.stringify(sentCommands)}`);
  }

  {
    const { page, getLastModal, sentCommands } = loadWash(true);
    TEST('after confirm sends uv_self_test');
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.runUvSelfTest();
    getLastModal().success({ confirm: true });
    await settle();
    if (sentCommands.length === 1 && sentCommands[0].command === 'uv_self_test') PASS();
    else FAIL(`expected uv_self_test, got ${JSON.stringify(sentCommands)}`);
  }

  {
    const { page, getLastModal, sentCommands } = loadWash(true);
    TEST('payload does not carry arbitrary duration');
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.runUvSelfTest();
    getLastModal().success({ confirm: true });
    await settle();
    const payload = sentCommands[0] && sentCommands[0].payload;
    if (payload && payload.duration === undefined && payload.duration_ms === undefined) PASS();
    else FAIL(`payload must not carry duration: ${JSON.stringify(payload)}`);
  }

  {
    const { page, getLastModal, sentCommands } = loadWash(true);
    TEST('repeated click is locked while busy');
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.runUvSelfTest();
    getLastModal().success({ confirm: true });
    await settle();
    /* busy is now true until poll completes; a second click must not resend */
    page.runUvSelfTest();
    await settle();
    const sends = sentCommands.filter(c => c.command === 'uv_self_test').length;
    if (sends === 1) PASS();
    else FAIL(`expected exactly 1 send, got ${sends}`);
  }

  {
    const { page, getLastModal } = loadWash(true, { protocolSnapshot: {
      connected: true, protocolReady: true, deviceId: 'p',
      serviceId: 's', writeCharId: 'w', notifyCharId: 'n', status: { uv_self_test: 2 }
    }});
    TEST('ACCEPTED shows running');
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.runUvSelfTest();
    getLastModal().success({ confirm: true });
    await settle();
    page.pollUvSelfTest();
    await wait(600);
    if (page.data.diagSelftestPhase === 'running') PASS();
    else FAIL(`expected running, got ${page.data.diagSelftestPhase}`);
    page.stopDiagPoll();
  }

  {
    const { page, getLastModal } = loadWash(true, { protocolSnapshot: {
      connected: true, protocolReady: true, deviceId: 'p',
      serviceId: 's', writeCharId: 'w', notifyCharId: 'n', status: { uv_self_test: 4 }
    }});
    TEST('COMPLETE shows auto-off');
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.pollUvSelfTest();
    await wait(600);
    if (page.data.diagSelftestPhase === 'complete' &&
        page.data.diagSelftestStatus.indexOf('已自动关闭') >= 0) PASS();
    else FAIL(`expected complete, got ${page.data.diagSelftestPhase}`);
    page.stopDiagPoll();
  }

  {
    const { page, getLastModal } = loadWash(true);
    TEST('every reject reason has readable copy');
    const codes = [
      'MACHINE_NOT_IDLE', 'UV_BUSY', 'POSITION_UNKNOWN', 'POSITION_STALE',
      'POSITION_UNSTABLE', 'POSITION_NOT_ZERO', 'MOTOR_MOVING',
      'FAULT_ACTIVE', 'EMERGENCY_ACTIVE', 'MCP_UNKNOWN',
      'UV_NOT_CONFIRMED_OFF', 'NOT_SUPPORTED'
    ];
    let ok = true;
    for (const c of codes) {
      const text = page.mapDiagReject(c);
      if (!text || text.indexOf(c) >= 0 || text === '') { ok = false; }
    }
    if (ok) PASS(); else FAIL('some reject code missing readable copy');
  }

  {
    const { page, getLastModal } = loadWash(true);
    TEST('BLE disconnect marks status unknown');
    page.data.diagSelftestBusy = true;
    page.data.diagSelftestPhase = 'running';
    page.markDiagStatusUnknown();
    if (page.data.diagSelftestPhase === 'unknown' &&
        page.data.diagSelftestBusy === false) PASS();
    else FAIL('disconnect must clear to unknown');
  }

  {
    const { page, getLastModal, cloudCalls } = loadWash(true);
    TEST('selftest does not call createOrderV2');
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.runUvSelfTest();
    getLastModal().success({ confirm: true });
    await settle();
    if (!cloudCalls.includes('createOrderV2')) PASS();
    else FAIL('selftest must not create an order');
  }

  {
    const { page, getLastModal } = loadWash(true);
    TEST('selftest does not modify allowUv state');
    page.data.uvDisinfectionEnabled = false;
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.runUvSelfTest();
    getLastModal().success({ confirm: true });
    await settle();
    if (page.data.uvDisinfectionEnabled === false) PASS();
    else FAIL('selftest must not touch uvDisinfectionEnabled');
  }

  {
    const { page, getLastModal } = loadWash(false);
    TEST('production switch off hides dev entry');
    const wxmlGated = washWxml.indexOf('wx:if="{{diagEnabled}}"') >= 0;
    if (page.data.diagEnabled === false && wxmlGated) PASS();
    else FAIL('diagEnabled must be false and WXML must gate the section');
  }

  console.log(`\nUV_SELFTEST_FLOW_TESTS=${testsPassed}/${testsRun} PASS`);
  process.exit(testsFailed === 0 ? 0 : 1);
}

main();
