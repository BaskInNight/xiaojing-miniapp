'use strict';

/*
 * test_act_selftest_flow.js — 执行器板测（阀/泵）开发诊断契约测试
 *
 * Required cases:
 *   1. capabilities 控制三个按钮显示
 *   2. 三个目标有正确确认弹窗文案
 *   3. 未确认弹窗不发送命令
 *   4. 确认后发送 actuator_self_test + 正确 target
 *   5. payload 不含 duration（时长由固件固定）
 *   6. 重复点击被锁定（busy 禁用）
 *   7. busy 时三个按钮全部禁用（WXML 层）
 *   8. ACCEPTED 显示已受理
 *   9. 每个拒绝 reason 有用户可读文案
 *   10. RUNNING 显示运行中
 *   11. COMPLETE 显示完成
 *   12. INTERRUPTED 显示中断
 *   13. TIMEOUT 显示超时
 *   14. FAULT 显示故障
 *   15. BLE 断开显示待确认
 *   16. 不调用 createOrderV2
 *   17. 不修改 allowUv
 *   18. 发布开关 false 时按钮不可见
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
  const actAck = override.actAck || {
    type: 'ack', ok: true, code: 'ACTUATOR_SELF_TEST_ACCEPTED',
    target: 'source_valve', duration_ms: 1500
  };

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
      if (command === 'actuator_self_test') {
        if (override.actReject) {
          const err = new Error('rejected');
          err.code = override.actReject;
          return Promise.reject(err);
        }
        return Promise.resolve(actAck);
      }
      if (command === 'uv_self_test') {
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

function capabilitiesMsg(targets) {
  return {
    v: 1,
    type: 'capabilities',
    actuator_self_test_targets: targets || ['source_valve', 'transfer_valve', 'detergent_pump']
  };
}

async function main() {
  {
    const { page } = loadWash(true);
    TEST('capabilities gate all three buttons');
    page.handleProtocolMessage(capabilitiesMsg(['source_valve', 'transfer_valve', 'detergent_pump']));
    if (page.data.diagActSourceSupported && page.data.diagActTransferSupported &&
        page.data.diagActDetergentSupported) PASS();
    else FAIL('all three must be supported');
  }

  {
    const { page } = loadWash(true);
    TEST('capabilities subset hides unsupported targets');
    page.handleProtocolMessage(capabilitiesMsg(['source_valve']));
    if (page.data.diagActSourceSupported && !page.data.diagActTransferSupported &&
        !page.data.diagActDetergentSupported) PASS();
    else FAIL('subset negotiation failed');
  }

  {
    const { page, getLastModal } = loadWash(true);
    TEST('source_valve confirm dialog carries water-tank warning');
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.runActuatorSelftest({ currentTarget: { dataset: { target: 'source_valve' } } });
    const modal = getLastModal();
    if (modal && modal.content.indexOf('有压进水阀') >= 0 &&
        modal.content.indexOf('1.5 秒') >= 0) PASS();
    else FAIL(`bad source_valve dialog: ${modal && modal.content}`);
  }

  {
    const { page, getLastModal } = loadWash(true);
    TEST('detergent_pump confirm dialog carries pump-tube warning');
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.runActuatorSelftest({ currentTarget: { dataset: { target: 'detergent_pump' } } });
    const modal = getLastModal();
    if (modal && modal.content.indexOf('泵管已安装') >= 0 &&
        modal.content.indexOf('0.8 秒') >= 0) PASS();
    else FAIL(`bad detergent dialog: ${modal && modal.content}`);
  }

  {
    const { page, getLastModal, sentCommands } = loadWash(true);
    TEST('unconfirmed modal does not send actuator command');
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.runActuatorSelftest({ currentTarget: { dataset: { target: 'source_valve' } } });
    getLastModal().success({ confirm: false });
    await settle();
    if (sentCommands.length === 0) PASS();
    else FAIL(`sent without confirm: ${JSON.stringify(sentCommands)}`);
  }

  {
    const { page, getLastModal, sentCommands } = loadWash(true);
    TEST('confirm sends actuator_self_test with target');
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.runActuatorSelftest({ currentTarget: { dataset: { target: 'transfer_valve' } } });
    getLastModal().success({ confirm: true });
    await settle();
    if (sentCommands.length === 1 &&
        sentCommands[0].command === 'actuator_self_test' &&
        sentCommands[0].payload.target === 'transfer_valve') PASS();
    else FAIL(`expected actuator_self_test, got ${JSON.stringify(sentCommands)}`);
  }

  {
    const { page, getLastModal, sentCommands } = loadWash(true);
    TEST('payload does not carry duration (firmware-fixed)');
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.runActuatorSelftest({ currentTarget: { dataset: { target: 'source_valve' } } });
    getLastModal().success({ confirm: true });
    await settle();
    const payload = sentCommands[0] && sentCommands[0].payload;
    if (payload && payload.duration === undefined && payload.duration_ms === undefined) PASS();
    else FAIL(`payload must not carry duration: ${JSON.stringify(payload)}`);
  }

  {
    const { page, getLastModal, sentCommands } = loadWash(true);
    TEST('repeated click locked while busy');
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.runActuatorSelftest({ currentTarget: { dataset: { target: 'source_valve' } } });
    getLastModal().success({ confirm: true });
    await settle();
    /* busy is now true; a second click must early-return (no new modal,
       no resend).  Re-confirming the stale modal would double-send, so the
       test must NOT invoke the old modal handler again. */
    page.runActuatorSelftest({ currentTarget: { dataset: { target: 'source_valve' } } });
    await settle();
    const sends = sentCommands.filter(c => c.command === 'actuator_self_test').length;
    if (sends === 1 && page.data.diagActBusy === true) PASS();
    else FAIL(`expected 1 send + busy, got sends=${sends} busy=${page.data.diagActBusy}`);
    page.stopActPoll();
  }

  {
    const { page } = loadWash(true);
    TEST('busy disables all three buttons in WXML');
    page.setData({ diagActBusy: true });
    const disabledOk = washWxml.indexOf(
      'disabled="{{diagActBusy || diagSelftestBusy || diagIlkBusy || diagBleBusy || !bleConnected}}"') >= 0;
    if (disabledOk) PASS();
    else FAIL('WXML must disable actuator buttons when busy');
  }

  {
    const { page, getLastModal } = loadWash(true);
    TEST('ACCEPTED shows accepted status');
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.runActuatorSelftest({ currentTarget: { dataset: { target: 'source_valve' } } });
    getLastModal().success({ confirm: true });
    await settle();
    if (page.data.diagActPhase === 'accepted' &&
        page.data.diagActStatus.indexOf('已受理') >= 0) PASS();
    else FAIL(`expected accepted, got ${page.data.diagActPhase}`);
    page.stopActPoll();
  }

  {
    const { page } = loadWash(true);
    TEST('every reject reason has readable copy');
    const codes = [
      'EXECUTOR_BUSY', 'SELF_TEST_BUSY', 'FAULT_ACTIVE', 'EMERGENCY_ACTIVE',
      'POSITION_UNKNOWN', 'POSITION_STALE', 'POSITION_UNSTABLE', 'MOTOR_MOVING',
      'POSITION_NOT_ZERO', 'OUTPUT_STATE_UNKNOWN', 'OUTPUT_ALREADY_ON',
      'CONFLICT_OUTPUT_ON', 'SERVICE_BUSY', 'REQUEST_ID_INVALID',
      'UNKNOWN_TARGET', 'NOT_SUPPORTED'
    ];
    let ok = true;
    for (const c of codes) {
      const text = page.mapActReject(c);
      if (!text || text === '' || text.indexOf(c) >= 0) { ok = false; }
    }
    if (ok) PASS(); else FAIL('some reject code missing readable copy');
  }

  {
    const { page, getLastModal } = loadWash(true, { protocolSnapshot: {
      connected: true, protocolReady: true, deviceId: 'p',
      serviceId: 's', writeCharId: 'w', notifyCharId: 'n',
      status: { actuator_self_test: { st: 3, tg: 1, rid: 2, dur: 1500, off: 0 } }
    }});
    TEST('RUNNING shows running');
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.pollActuatorSelftest();
    await wait(600);
    if (page.data.diagActPhase === 'running') PASS();
    else FAIL(`expected running, got ${page.data.diagActPhase}`);
    page.stopActPoll();
  }

  {
    const { page, getLastModal } = loadWash(true, { protocolSnapshot: {
      connected: true, protocolReady: true, deviceId: 'p',
      serviceId: 's', writeCharId: 'w', notifyCharId: 'n',
      status: { actuator_self_test: { st: 4, tg: 1, rid: 2, dur: 1500, off: 1 } }
    }});
    TEST('COMPLETE shows confirmed-off');
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.pollActuatorSelftest();
    await wait(600);
    if (page.data.diagActPhase === 'complete' &&
        page.data.diagActStatus.indexOf('已确认关闭') >= 0) PASS();
    else FAIL(`expected complete, got ${page.data.diagActPhase}`);
    page.stopActPoll();
  }

  {
    const { page, getLastModal } = loadWash(true, { protocolSnapshot: {
      connected: true, protocolReady: true, deviceId: 'p',
      serviceId: 's', writeCharId: 'w', notifyCharId: 'n',
      status: { actuator_self_test: { st: 6, tg: 1, rid: 2, dur: 1500, off: 0 } }
    }});
    TEST('INTERRUPTED shows interrupted');
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.pollActuatorSelftest();
    await wait(600);
    if (page.data.diagActPhase === 'interrupted') PASS();
    else FAIL(`expected interrupted, got ${page.data.diagActPhase}`);
    page.stopActPoll();
  }

  {
    const { page, getLastModal } = loadWash(true, { protocolSnapshot: {
      connected: true, protocolReady: true, deviceId: 'p',
      serviceId: 's', writeCharId: 'w', notifyCharId: 'n',
      status: { actuator_self_test: { st: 7, tg: 1, rid: 2, dur: 1500, off: 0 } }
    }});
    TEST('TIMEOUT shows timeout');
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.pollActuatorSelftest();
    await wait(600);
    if (page.data.diagActPhase === 'timeout') PASS();
    else FAIL(`expected timeout, got ${page.data.diagActPhase}`);
    page.stopActPoll();
  }

  {
    const { page, getLastModal } = loadWash(true, { protocolSnapshot: {
      connected: true, protocolReady: true, deviceId: 'p',
      serviceId: 's', writeCharId: 'w', notifyCharId: 'n',
      status: { actuator_self_test: { st: 8, tg: 1, rid: 2, dur: 1500, off: 0 } }
    }});
    TEST('FAULT with off=0 shows fault');
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.pollActuatorSelftest();
    await wait(600);
    if (page.data.diagActPhase === 'fault') PASS();
    else FAIL(`expected fault, got ${page.data.diagActPhase}`);
    page.stopActPoll();
  }

  {
    const { page } = loadWash(true);
    TEST('BLE disconnect marks actuator status pending-confirm');
    page.data.diagActBusy = true;
    page.data.diagActPhase = 'running';
    page.markActStatusUnknown();
    if (page.data.diagActPhase === 'unknown' &&
        page.data.diagActBusy === false &&
        page.data.diagActStatus.indexOf('待设备确认') >= 0) PASS();
    else FAIL(`disconnect must clear to unknown, got ${page.data.diagActStatus}`);
  }

  {
    const { page, getLastModal, cloudCalls } = loadWash(true);
    TEST('actuator selftest does not create an order');
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.runActuatorSelftest({ currentTarget: { dataset: { target: 'source_valve' } } });
    getLastModal().success({ confirm: true });
    await settle();
    if (!cloudCalls.includes('createOrderV2')) PASS();
    else FAIL('must not create an order');
  }

  {
    const { page, getLastModal } = loadWash(true);
    TEST('actuator selftest does not modify allowUv state');
    page.data.uvDisinfectionEnabled = false;
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.runActuatorSelftest({ currentTarget: { dataset: { target: 'source_valve' } } });
    getLastModal().success({ confirm: true });
    await settle();
    if (page.data.uvDisinfectionEnabled === false) PASS();
    else FAIL('must not touch uvDisinfectionEnabled');
  }

  {
    const { page } = loadWash(false);
    TEST('production switch off hides actuator buttons');
    if (page.data.diagEnabled === false && page.data.diagActSourceSupported === false) PASS();
    else FAIL('diagEnabled must gate actuator UI');
  }

  /* ===== 热风模块（单继电器耦合：风扇+加热丝并联同步通电） ===== */

  {
    const { page } = loadWash(true);
    TEST('capabilities gates hot-air button on hot_air_coupled');
    page.handleProtocolMessage(capabilitiesMsg(
      ['source_valve', 'transfer_valve', 'detergent_pump', 'hot_air_coupled']));
    if (page.data.diagActHotAirSupported && !page.data.diagActFanSupported) PASS();
    else FAIL(`hot_air_coupled must be supported, fan must not: ${JSON.stringify(page.data)}`);
  }

  {
    const { page } = loadWash(true);
    TEST('capabilities without hot_air_coupled hides hot-air button');
    page.handleProtocolMessage(capabilitiesMsg(['source_valve', 'transfer_valve', 'detergent_pump']));
    if (!page.data.diagActHotAirSupported) PASS();
    else FAIL('hot-air button must be hidden when capability absent');
  }

  {
    const { page, getLastModal } = loadWash(true);
    TEST('hot-air confirm dialog warns fan+heater energize together');
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.runActuatorSelftest({ currentTarget: { dataset: { target: 'hot_air_coupled' } } });
    const modal = getLastModal();
    if (modal && modal.content.indexOf('风扇与加热丝将同步通电') >= 0 &&
        modal.content.indexOf('1 秒') >= 0) PASS();
    else FAIL(`bad hot-air dialog: ${modal && modal.content}`);
  }

  {
    const { page, getLastModal, sentCommands } = loadWash(true);
    TEST('hot-air confirm sends actuator_self_test target hot_air_coupled');
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.runActuatorSelftest({ currentTarget: { dataset: { target: 'hot_air_coupled' } } });
    getLastModal().success({ confirm: true });
    await settle();
    if (sentCommands.length === 1 &&
        sentCommands[0].command === 'actuator_self_test' &&
        sentCommands[0].payload.target === 'hot_air_coupled') PASS();
    else FAIL(`expected hot_air_coupled, got ${JSON.stringify(sentCommands)}`);
    page.stopActPoll();
  }

  {
    const { page } = loadWash(true);
    TEST('hot-air cooldown from status cd starts countdown and disables button');
    page.handleProtocolMessage({
      v: 1, type: 'status',
      state: 1, phase: 0, progress: 0, program_id: 0,
      actuator_self_test: { st: 0, tg: 0, rid: 0, dur: 0, off: 1, cd: 12000 }
    });
    if (page.data.diagActCooldownMs === 12000 &&
        page.data.diagActCooldownText.indexOf('热风冷却中') >= 0 &&
        washWxml.indexOf('diagActCooldownMs > 0') >= 0) PASS();
    else FAIL(`cooldown not started: ${page.data.diagActCooldownMs}`);
    page.stopActCooldown();
  }

  {
    const { page } = loadWash(true);
    TEST('hot-air cooldown clears when firmware reports cd=0');
    page.setData({ diagActCooldownMs: 5000, diagActCooldownText: '热风冷却中' });
    page.syncActCooldown(0);
    if (page.data.diagActCooldownMs === 0 && page.data.diagActCooldownText === '') PASS();
    else FAIL(`cooldown must clear, got ${page.data.diagActCooldownMs}`);
  }

  {
    const { page } = loadWash(true, { protocolSnapshot: {
      connected: true, protocolReady: true, deviceId: 'p',
      serviceId: 's', writeCharId: 'w', notifyCharId: 'n',
      status: { actuator_self_test: { st: 4, tg: 1, rid: 2, dur: 1000, off: 0, cd: 30000 } }
    }});
    TEST('hot-air reconnect: COMPLETE off=0 must NOT claim confirmed-off');
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.data.diagActTarget = 'hot_air_coupled';
    page.pollActuatorSelftest();
    await wait(600);
    if (page.data.diagActPhase === 'complete' &&
        page.data.diagActStatus.indexOf('未确认关闭') >= 0 &&
        page.data.diagActStatus.indexOf('已确认关闭') < 0) PASS();
    else FAIL(`must not claim confirmed-off without off=1: ${page.data.diagActStatus}`);
    page.stopActPoll(); page.stopActCooldown();
  }

  {
    const { page } = loadWash(true, { protocolSnapshot: {
      connected: true, protocolReady: true, deviceId: 'p',
      serviceId: 's', writeCharId: 'w', notifyCharId: 'n',
      status: { actuator_self_test: { st: 4, tg: 1, rid: 2, dur: 1000, off: 1, cd: 30000 } }
    }});
    TEST('hot-air reconnect: COMPLETE off=1 shows confirmed-off + starts cooldown');
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.data.diagActTarget = 'hot_air_coupled';
    page.pollActuatorSelftest();
    await wait(600);
    if (page.data.diagActPhase === 'complete' &&
        page.data.diagActStatus.indexOf('已确认关闭') >= 0 &&
        page.data.diagActCooldownMs === 30000) PASS();
    else FAIL(`expected confirmed-off + cooldown: ${page.data.diagActStatus}`);
    page.stopActPoll(); page.stopActCooldown();
  }

  {
    const { page } = loadWash(true);
    TEST('hot-air BLE disconnect shows emergency-shutdown pending wording');
    page.data.diagActTarget = 'hot_air_coupled';
    page.data.diagActBusy = true;
    page.data.diagActPhase = 'running';
    page.markActStatusUnknown();
    if (page.data.diagActStatus.indexOf('已请求紧急关断，等待设备确认') >= 0) PASS();
    else FAIL(`hot-air disconnect wording wrong: ${page.data.diagActStatus}`);
  }

  {
    const { page } = loadWash(true);
    TEST('hot-air reject codes have readable copy');
    const codes = [
      'HOT_AIR_COOLDOWN_ACTIVE', 'HOT_AIR_TEMP_TOO_HIGH',
      'HOT_AIR_SNAPSHOT_UNAVAILABLE'
    ];
    let ok = true;
    for (const c of codes) {
      const text = page.mapActReject(c);
      if (!text || text === '' || text.indexOf(c) >= 0) { ok = false; }
    }
    if (ok) PASS(); else FAIL('some hot-air reject code missing readable copy');
  }

  {
    const { page } = loadWash(true);
    TEST('WXML: hot-air button present, legacy fan button absent');
    if (washWxml.indexOf('热风模块安全自检（1 秒）') >= 0 &&
        washWxml.indexOf('data-target="fan"') < 0) PASS();
    else FAIL('WXML must show hot-air button and drop fan button');
  }

  {
    const { page } = loadWash(true, { protocolSnapshot: {
      connected: true, protocolReady: true, deviceId: 'p',
      serviceId: 's', writeCharId: 'w', notifyCharId: 'n',
      status: { actuator_self_test: { st: 8, tg: 1, rid: 2, dur: 1000, off: 0, cd: 30000 } }
    }});
    TEST('hot-air FAULT off=0 keeps dangerous not-confirmed wording');
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.data.diagActTarget = 'hot_air_coupled';
    page.pollActuatorSelftest();
    await wait(600);
    if (page.data.diagActPhase === 'fault' &&
        page.data.diagActStatus.indexOf('未确认关闭') >= 0 &&
        page.data.diagActStatus.indexOf('立即断电检查') >= 0) PASS();
    else FAIL(`FAULT off=0 must warn not-confirmed: ${page.data.diagActStatus}`);
    page.stopActPoll(); page.stopActCooldown();
  }

  {
    const { page } = loadWash(true, { protocolSnapshot: {
      connected: true, protocolReady: true, deviceId: 'p',
      serviceId: 's', writeCharId: 'w', notifyCharId: 'n',
      status: { actuator_self_test: { st: 8, tg: 1, rid: 2, dur: 1000, off: 1, cd: 0 } }
    }});
    TEST('hot-air FAULT off=1 shows non-danger wording (fault but confirmed-off)');
    page.data.bleConnected = true; page.data.protocolReady = true;
    page.data.diagActTarget = 'hot_air_coupled';
    page.pollActuatorSelftest();
    await wait(600);
    if (page.data.diagActPhase === 'fault' &&
        page.data.diagActStatus.indexOf('未确认关闭') < 0 &&
        page.data.diagActStatus.indexOf('立即断电检查') < 0) PASS();
    else FAIL(`FAULT off=1 must not claim unconfirmed-off: ${page.data.diagActStatus}`);
    page.stopActPoll(); page.stopActCooldown();
  }

  console.log(`\nACT_SELFTEST_FLOW_TESTS=${testsPassed}/${testsRun} PASS`);
  process.exit(testsFailed === 0 ? 0 : 1);
}

main();
