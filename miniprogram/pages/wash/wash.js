const app = getApp();
const ble = require('../../utils/ble.js');
const version = require('../../utils/version.js');

/* 固件 uv_self_test 状态码（与 uv_self_test_core.h 的 uv_self_test_state_t 一致） */
const UV_SELF_TEST_STATUS = {
  INACTIVE: 0,
  VALIDATING: 1,
  RUNNING: 2,
  STOPPING: 3,
  COMPLETE: 4,
  REJECTED: 5,
  FAULT: 6,
  INTERRUPTED: 7,
  TIMEOUT: 8,
  UNKNOWN: 9
};
const UV_SELF_TEST_STATUS_LABEL = {
  0: '空闲',
  1: '正在检查安全条件',
  2: 'UV 自检运行中（3 秒）',
  3: 'UV 正在自动关闭…',
  4: 'UV 已自动关闭',
  5: '自检被拒绝',
  6: '关灯失败：请立即断电检查',
  7: '自检被中断（已取消/跳过）',
  8: '自检超时结束',
  9: '自检状态未知'
};

/* 固件 actuator_self_test 状态码（与 actuator_self_test_core.h 的
 * actuator_self_test_state_t 一致） */
const ACT_SELF_TEST_STATUS = {
  INACTIVE: 0,
  CHECKING: 1,
  ACCEPTED: 2,
  RUNNING: 3,
  COMPLETE: 4,
  REJECTED: 5,
  INTERRUPTED: 6,
  TIMEOUT: 7,
  FAULT: 8,
  UNKNOWN: 9
};

/* 执行器板测目标元数据（名称 / 确认文案 / 状态文案前缀） */
const ACT_TARGET_INFO = {
  source_valve: {
    label: '有压进水阀',
    durationLabel: '约 1.5 秒',
    confirm: '确认水路已接入容器并可立即断电。设备将开启有压进水阀约 1.5 秒。'
  },
  transfer_valve: {
    label: '零压转移阀',
    durationLabel: '约 1.5 秒',
    confirm: '确认中间水箱和洗涤桶水路已接好。设备将开启转移阀约 1.5 秒。'
  },
  detergent_pump: {
    label: '洗涤剂蠕动泵',
    durationLabel: '约 0.8 秒',
    confirm: '确认泵管已安装。设备将运行蠕动泵约 0.8 秒。'
  },
  drain_pump: {
    label: '排水泵',
    durationLabel: '约 2 秒',
    confirm: '确认排水管已接好。请先将桶转到 180° 对齐位置且电机停稳。设备将运行排水泵约 2 秒。'
  },
  hot_air_coupled: {
    label: '热风模块',
    durationLabel: '1 秒',
    /* 高危双重确认：单继电器风扇与加热丝并联同步通电。 */
    confirm: '⚠ 高温风险：请先将桶转到 270° 对齐位置且电机停稳。风扇与加热丝将同步通电约 1 秒，请确认设备前无人、周边无易燃物，并已做好断电准备。'
  }
};

/* 固件 motor_bench 状态码（与 motor_bench_core.h 的 motor_bench_state_t 一致） */
const MB_STATE = {
  INACTIVE: 0, PRECHECK: 1, WAIT_POSITION: 2, WAIT_CONFIRM: 3,
  PULSING: 4, OFF_CONFIRM: 5, COMPLETE: 6, REJECTED: 7,
  INTERRUPTED: 8, TIMEOUT: 9, FAULT: 10
};

/* 固件 motor_bench 终端码（motor_bench_terminal_t） */
const MB_TERMINAL = {
  NONE: 0, COMPLETE: 1, REJECTED: 2, INTERRUPTED: 3, TIMEOUT: 4, FAULT: 5
};

/* 电机空载台架类型元数据（target 名 / 展示文案 / 位置说明） */
const MB_TYPE_INFO = {
  pulsator: { label: '搅动电机', pos: '0°', desc: 'ZS-X11B 单次低速脉冲自检' },
  drum: { label: '滚筒', pos: '90°', desc: '滚筒/BLDC 单步自检' },
  hall_sequence: { label: '3 步序列', pos: '0°→90°→180°', desc: '人工霍尔流程台架（进阶）' },
  pulsator_behavior: { label: '搅动行为', pos: '0°', desc: '正转-滑停-反向交替 ~15s（目视验证）' }
};

function isRealBleDeviceId(value) {
  if (typeof value !== 'string') return false;
  const id = value.trim();
  if (!id || id === 'undefined' || id === 'null') return false;
  if (id.startsWith(ble.DEVICE_NAME_PREFIX)) return false;
  if (id.startsWith('device_')) return false;
  return true;
}

function makeClientRequestId() {
  return `wx_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

/* 从 capabilities 快照/推送重建诊断开关。唯一权威解析点，handleProtocolMessage
 * 与 onLoad/onShow 快照同步共用，避免两处重复导致能力门控漂移。 */
function diagFlagsFromCapabilities(cap, currentMbType) {
  const actTargets = Array.isArray(cap && cap.actuator_self_test_targets)
    ? cap.actuator_self_test_targets : [];
  const diagList = Array.isArray(cap && cap.diagnostics)
    ? cap.diagnostics : [];
  const mbTypes = Array.isArray(cap && cap.motor_bench_types)
    ? cap.motor_bench_types : [];
  return {
    diagActSourceSupported: actTargets.indexOf('source_valve') >= 0,
    diagActTransferSupported: actTargets.indexOf('transfer_valve') >= 0,
    diagActDetergentSupported: actTargets.indexOf('detergent_pump') >= 0,
    diagActDrainSupported: actTargets.indexOf('drain_pump') >= 0,
    diagActHotAirSupported: actTargets.indexOf('hot_air_coupled') >= 0,
    diagMbEnabled: diagList.indexOf('motor_bench_self_test') >= 0 &&
      mbTypes.length > 0,
    diagMbTypes: mbTypes,
    diagMbCalSupported: diagList.indexOf('set_direction_calibration') >= 0,
    diagPosEnabled: diagList.indexOf('position_move_test') >= 0,
    diagSwingEnabled: diagList.indexOf('position_swing_test') >= 0,
    /* capabilities 会在重连、onShow 主动 hello 等路径重复到达。若用户已选
     * pulsator_behavior，不能在同步时无条件弹回 pulsator。仅当当前类型已
     * 不被固件支持时，才回退到默认单方向类型。 */
    diagMbType: mbTypes.indexOf(currentMbType) >= 0
      ? currentMbType
      : (mbTypes.indexOf('pulsator') >= 0
        ? 'pulsator' : (mbTypes[0] || 'pulsator'))
  };
}

function normalizeBookingSteps(source) {
  const defaults = {
    soak:  { enabled: true, count: 1, time: 5, price: 0 },
    wash:  { enabled: true, count: 2, time: 5, price: 0 },
    rinse: { enabled: true, count: 3, time: 5, price: 0 },
    dry:   { enabled: false, count: 0, time: 20, price: 1 }
  };
  const input = source && typeof source === 'object' ? source : {};
  Object.keys(defaults).forEach(key => {
    const item = input[key];
    if (!item || typeof item !== 'object') return;
    const count = Math.max(0, Math.min(10, Number(item.count) || 0));
    const time = Math.max(1, Math.min(180, Number(item.time) || defaults[key].time));
    defaults[key] = {
      enabled: item.enabled === true && count > 0,
      count,
      time,
      price: key === 'dry' ? 1 : 0
    };
  });
  return defaults;
}

Page({
  data: {
    // 蓝牙状态
    bleConnected: false,
    bleDeviceId: '',
    bleDeviceName: '',
    bleServiceId: '',
    bleWriteCharId: '',
    bleNotifyCharId: '',
    bleRSSI: '',
    protocolReady: false,

    // 套餐选择
    selectedPackage: 'quick',
    // 当前 ESP32 V1 正式程序由设备侧 planner 生成安全流程。
    // 旧版四阶段次数不能一一映射，暂不向设备发送这些自定义值。
    protocolProfileOnly: true,
    useCoupon: false,
    // 套餐基础价（quick=¥1, dry=¥2）
    packageBasePrice: 1,

    // UV 消毒附加项（默认关闭，安全优先）
    uvDisinfectionEnabled: false,

    // ========== 开发测试（UV 灯安全自检，仅诊断） ==========
    diagEnabled: !!version.MINIAPP_ENABLE_HARDWARE_DIAGNOSTICS,
    diagVersion: version.MINIAPP_VERSION,
    diagExpanded: false,
    diagSelftestBusy: false,
    diagSelftestPhase: 'idle',      // idle|checking|accepted|running|complete|rejected|fault|unknown
    diagSelftestStatus: '',

    // ========== 开发测试（执行器板测：阀/泵，仅诊断） ==========
    diagActBusy: false,
    diagActPhase: 'idle',           // idle|checking|accepted|running|complete|rejected|interrupted|timeout|fault|unknown
    diagActStatus: '',
    diagActTarget: '',
    diagActSourceSupported: false,
    diagActTransferSupported: false,
    diagActDetergentSupported: false,
    diagActDrainSupported: false,
    diagActHotAirSupported: false,
    diagActCooldownMs: 0,           // 热风模块冷却剩余 ms（固件权威）
    diagActCooldownText: '',        // 「热风冷却中：约 N 秒后重试」

    // ========== 自动负向测试（仅诊断）：阀互锁 ==========
    // source 自检受理后 200ms 请求 transfer，必须被冲突拒绝码拒绝。
    diagIlkBusy: false,
    diagIlkPhase: 'idle',           // idle|req_source|source_accepted|transfer_done|done|fail
    diagIlkStatus: '',
    diagIlkSourceAck: '',
    diagIlkTransferAck: '',
    diagIlkTerminal: '',
    diagIlkOff: false,
    diagIlkResult: '',              // PASS|FAIL

    // ========== 自动负向测试（仅诊断）：BLE 断线自动关断 ==========
    // source 自检受理后 250ms 主动断开 BLE，重连后查询终态与 OFF 确认。
    diagBleBusy: false,
    diagBlePhase: 'idle',           // idle|req_source|source_accepted|disconnect|done|fail
    diagBleStatus: '',
    diagBleTerminal: '',
    diagBleLastCode: '',
    diagBleOff: false,
    diagBleResult: '',              // PASS|FAIL|INFO

    // ========== 开发测试（电机空载台架，仅诊断） ==========
    // 固件 motor_bench_self_test：开始只检查门禁；二次确认后每次仅提交一次 5s 测试。
    diagMbEnabled: false,           // capability 含 motor_bench_self_test
    diagMbTypes: [],                // ['pulsator','drum','hall_sequence']
    diagMbType: 'pulsator',         // 当前选中台架类型
    diagMbBusy: false,              // 台架运行中（未终态）
    diagMbPhase: 'idle',            // idle|checking|wait_pos|wait_confirm|confirming|pulsing|off_confirm|complete|rejected|interrupted|timeout|fault|unknown
    diagMbStatus: '',
    diagMbPos: 0,                   // 当前步所需位置（°）
    diagMbStep: 0,                  // 当前步 0-based
    diagMbSteps: 0,                 // 总步数
    diagMbReady: false,             // 位置已就位（ready=1）
    diagMbTerm: 0,                  // 终端码（MB_TERMINAL）
    diagMbOff: false,               // 输出确认关闭（off=1）
    diagMbLc: '',                   // 固件 last_code（ACCEPTED/拒绝/等待/终态码）
    diagMbCalSupported: false,      // capability 含 set_direction_calibration
    diagMbCalStatus: '',            // 方向标定结果文案
    diagPosEnabled: false,          // capability 含 position_move_test
    diagPosStatus: '',              // 换位电机测试结果文案
    diagCapSeen: false,             // 是否收到过固件 capabilities（判断固件版本是否支持新命令）
    diagSwingEnabled: false,        // capability 含 position_swing_test
    diagSwingBusy: false,           // 连续换向展示台运行中
    diagSwingPhase: 'idle',         // idle|checking|running_cw|braking|running_ccw|complete|rejected|interrupted|timeout|fault|unknown
    diagSwingStatus: '',
    diagSwingSegDone: 0,            // 已完成段数（0-based）
    diagSwingDirCw: true,           // 当前段方向
    diagSwingOff: false,            // output_confirmed_off
    diagSwingRounds: 4,             // 实际受理段数
    diagSwingDwellMs: 1500,         // 实际受理每段时长
    diagSwingTerm: 0,               // swing 终态码

    // ========== 板测诊断参数（滑杆 / 默认值） ==========
    diagBl50Pwm: 40,                // 搅动电机(ZS-X11B)台架脉冲 PWM 0-100
    diagIbt2Pwm: 80,                // 换位电机(IBT-2)测试 PWM 0-100
    diagActDurMs: 1500,             // 执行器自检时长 ms（0.2-10s）
    diagPrefsStatus: '',            // 参数设置/持久化结果文案

    // 自定义步骤
    customSteps: {
      soak:  { enabled: true, count: 1, time: 5, price: 0 },
      wash:  { enabled: true, count: 2, time: 5, price: 0 },
      rinse: { enabled: true, count: 3, time: 5, price: 0 },
      dry:   { enabled: false, count: 0, time: 20, price: 1 }
    },

    // 结算
    totalTime: 30,
    totalPrice: 1,
    finalPrice: 1,

    // 优惠券
    coupons: [],
    selectedCouponId: '',
    couponLoading: false,
    _discountValue: 0,

    // 清洗状态
    isWashing: false,
    progress: 0,
    remainingTime: 0,
    progressTimer: null,
    useRealProgress: false,
    commandBusy: false,
    machineState: 0,
    machinePhase: 0,
    statusText: '未连接设备',
    awaitingLoad: false,
    awaitingUnload: false,
    canSkipUv: false,
    faultCode: 0,
    faultDetail: 0,
    activeProgramId: 0,

    // AI 云端状态（从 3.2 迁移，对接 ESP32 语音 AI）
    lastAiStatus: null,
    currentAiSeq: 0,
    aiProcessing: false,
    expectedDisconnect: false,
    reconnecting: false,
    lastAiStatusAt: 0,
    reconnectAttempts: 0,
    maxReconnectAttempts: 30,
    deviceStatus: '',

    // ========== 预约相关 ==========
    isBooking: false,
    _currentOrderId: '',
    _sourceBookingId: '',
    _startNow: false,
    bookingDate: '',
    bookingTime: '',
    todayDate: '',
    maxDate: '',
    endTimePreview: '--:--'
  },

  onLoad: function (options) {
    this._pageAlive = true;
    // AI 自动重连定时器（实例属性，不放 data）
    this.aiReconnectTimer = null;
    this.aiReconnectStopped = false;
    this._clientRequestId = makeClientRequestId();

    this.loadCoupons();

    const snapshot = ble.getProtocolSnapshot();
    const rememberedDevice = ble.getRememberedDevice();
    const optionDeviceId = options.deviceId || '';
    const optionDeviceName = options.deviceName || '';
    const optionLooksRealBleId = isRealBleDeviceId(optionDeviceId);
    const optionLooksLikeName = optionDeviceId &&
      String(optionDeviceId).startsWith(ble.DEVICE_NAME_PREFIX);
    const optionLooksLikeCloudId = optionDeviceId &&
      String(optionDeviceId).startsWith('device_');
    const requestedRealDeviceId = optionLooksRealBleId ? optionDeviceId : '';
    const snapshotReady = snapshot.connected && snapshot.protocolReady &&
      snapshot.deviceId &&
      (!requestedRealDeviceId || requestedRealDeviceId === snapshot.deviceId);
    const rememberedRealDeviceId = isRealBleDeviceId(app.globalData.bleDeviceId)
      ? app.globalData.bleDeviceId
      : (rememberedDevice && isRealBleDeviceId(rememberedDevice.deviceId)
          ? rememberedDevice.deviceId : '');

    if (snapshotReady) {
      this.setData({
        bleConnected: true,
        protocolReady: true,
        bleDeviceId: snapshot.deviceId,
        bleDeviceName: app.globalData.bleDeviceName || optionDeviceName ||
          optionDeviceId,
        bleServiceId: snapshot.serviceId,
        bleWriteCharId: snapshot.writeCharId,
        bleNotifyCharId: snapshot.notifyCharId
      });
    } else if (optionLooksRealBleId || rememberedRealDeviceId) {
      this.setData({
        bleConnected: false,
        protocolReady: false,
        bleDeviceId: optionLooksRealBleId ? optionDeviceId : rememberedRealDeviceId,
        bleDeviceName: optionDeviceName || app.globalData.bleDeviceName ||
          (rememberedDevice && rememberedDevice.deviceName) || ''
      });
    } else if (optionDeviceId && (optionLooksLikeName || optionLooksLikeCloudId)) {
      this.setData({
        bleDeviceId: '',
        bleDeviceName: optionLooksLikeName ? optionDeviceId : optionDeviceName
      });
    } else if (optionDeviceName) {
      // Cloud order queries intentionally do not persist phone-specific BLE IDs.
      // Keep the advertised name so ensureBleReadyForCommand() can rescan.
      this.setData({
        bleDeviceId: '',
        bleDeviceName: optionDeviceName
      });
    }

    // 初始化日期范围
    const today = new Date();
    const todayStr = this.formatDate(today);
    const maxDate = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
    const maxDateStr = this.formatDate(maxDate);

    this.setData({
      todayDate: todayStr,
      maxDate: maxDateStr,
      bookingDate: todayStr,
      bookingTime: '08:00'
    });
    this.calculateEndTime();

    this.initBLEListener();
    this.syncDiagnosticsFromSnapshot();
    this.openDiagIfNotConnected();

    // 预约页点击“立即启动”：重新加载并启动原预约订单，不能新建默认订单。
    if (options.startNow === '1') {
      this.loadAndStartBooking(options.bookingId || '');
    }
  },

  onShow: function () {
    this._pageAlive = true;
    const snapshot = ble.getProtocolSnapshot();
    if (snapshot.connected && snapshot.protocolReady && snapshot.deviceId) {
      this.setData({
        bleConnected: true,
        protocolReady: true,
        bleDeviceId: snapshot.deviceId,
        bleDeviceName: app.globalData.bleDeviceName,
        bleServiceId: snapshot.serviceId,
        bleWriteCharId: snapshot.writeCharId,
        bleNotifyCharId: snapshot.notifyCharId
      });
    } else if (this.data.bleConnected || this.data.protocolReady) {
      this.setData({ bleConnected: false, protocolReady: false });
    }
    this.warmBleConnection();
    this.syncDiagnosticsFromSnapshot();
    this.openDiagIfNotConnected();
    /* 台架状态自愈：重入页面时若本地显示台架忙，重开轮询拉真实状态，
     * 清掉 SUBMIT_FAILED/断线后卡住的 stale busy（否则开始/标定按钮被禁用）。 */
    if (this.data.diagMbBusy) {
      this.pollMotorBench();
    }
  },

  onUnload: function () {
    this._pageAlive = false;
    this.clearProgressTimer();
    this.stopAutoReconnect();
    this.stopDiagPoll();
    this.stopIlkPoll();
    this.stopBleDiscPoll();
    this.stopMbPoll();
    ble.setReconnectCallbacks(null, null);
    if (this._bleUnsubscribe) {
      this._bleUnsubscribe();
      this._bleUnsubscribe = null;
    }
  },

  initBLEListener: function () {
    if (this._bleUnsubscribe) this._bleUnsubscribe();

    // BLE 模块独占全局监听并负责指数退避重连。页面只消费状态，
    // 不关闭适配器，也不把断线误判为洗衣程序已经停止。
    ble.setReconnectCallbacks(
      (info) => {
        this.setData({
          bleConnected: true,
          protocolReady: true,
          reconnecting: false,
          bleDeviceId: info.deviceId || this.data.bleDeviceId,
          bleServiceId: info.serviceId,
          bleWriteCharId: info.writeCharId,
          bleNotifyCharId: info.notifyCharId
        });
        app.globalData.bleConnected = true;
        app.globalData.bleDeviceId = info.deviceId || this.data.bleDeviceId;
        app.globalData.bleServiceId = info.serviceId;
        app.globalData.bleWriteCharId = info.writeCharId;
        app.globalData.bleNotifyCharId = info.notifyCharId;
        wx.showToast({ title: '蓝牙已重连', icon: 'success' });
        this.refreshDeviceStatus();
      },
      (state) => {
        const reconnecting = !!(state && state.reconnecting);
        this.setData({
          bleConnected: false,
          protocolReady: false,
          reconnecting: reconnecting,
          statusText: reconnecting ? '蓝牙断开，正在重连…' : '蓝牙已断开'
        });
        app.globalData.bleConnected = false;
        // BLE 断开：固件仅收到 emergency 关灯/关阀/关泵请求，未确认 OFF。
        this.markDiagStatusUnknown();
        this.markActStatusUnknown();
        this.markMbStatusUnknown();
        this.markSwingStatusUnknown();
        this.resetSwingOnDisconnect();
        if (!reconnecting) {
          wx.showModal({
            title: '连接已断开',
            content: '自动重连失败。设备内的洗衣程序不会因手机断线而停止，请靠近设备后重新连接查看状态。',
            showCancel: false,
            confirmText: '知道了'
          });
        }
      }
    );

    this._bleUnsubscribe = ble.onDataReceived(message => {
      this.handleProtocolMessage(message);
    });
  },

  /* 未连接/无 capabilities 时也保持开发测试区可见（板测协议能力由固件
   * hello 推送解析；在此之前先展开，让用户看到「连接后自动出现的按钮」）。
   * 叫 diagExpanded 展开 + diagMbTypes 默认非空，保证按钮区必渲染。 */
  openDiagIfNotConnected: function () {
    const snapshot = ble.getProtocolSnapshot();
    this.setData({
      diagExpanded: true,
      diagMbEnabled: true,
      diagMbCalSupported: true,
      diagPosEnabled: true,
      diagSwingEnabled: true,
      diagMbTypes: this.data.diagMbTypes && this.data.diagMbTypes.length
        ? this.data.diagMbTypes : ['pulsator', 'drum', 'hall_sequence', 'pulsator_behavior']
    });
    if (snapshot.connected && snapshot.capabilities) {
      this.setData({
        ...diagFlagsFromCapabilities(snapshot.capabilities, this.data.diagMbType)
      });
    }
    if (snapshot.connected && !snapshot.protocolReady) {
      ble.sendProtocolCommand('hello', {}, { timeoutMs: 3000, retries: 0 })
        .catch(() => {});
    }
  },

  /* 已连接但 cap 为 null（握手时页面未监听）：主动 hello 一次触发固件重发
   * capabilities，保证开发测试区的开关（波轮/换位/连续换向）在重连后必然可见。 */
  syncDiagnosticsFromSnapshot: function () {
    const snap = ble.getProtocolSnapshot();
    if (!snap.connected || !snap.protocolReady) {
      this.fetchDiagPrefs();
      return false;
    }
    if (snap.capabilities) {
      this.setData({
        protocolReady: true,
        ...diagFlagsFromCapabilities(snap.capabilities, this.data.diagMbType)
      });
      this.fetchDiagPrefs();
      return true;
    }
    ble.sendProtocolCommand('hello', {}, { timeoutMs: 3000, retries: 0 })
      .catch(() => {});
    this.fetchDiagPrefs();
    /* 快照连上但 cap 为潜在 null：保底打开展示台，等 hello 推送后由
     * handleProtocolMessage 用真实能力覆盖（不会真正误启未支持的按钮，
     * 按钮发出命令时服务端仍会拒绝——这层只是 UI 可见性保底）。 */
    this.setData({
      diagExpanded: true,
      diagMbEnabled: true,
      diagMbCalSupported: true,
      diagPosEnabled: true,
      diagSwingEnabled: true,
      diagMbTypes: this.data.diagMbTypes && this.data.diagMbTypes.length
        ? this.data.diagMbTypes
        : ['pulsator', 'drum', 'hall_sequence', 'pulsator_behavior']
    });
    return false;
  },

  /* 拉取当前板测诊断参数（来自 status → config.benchtst），用于初始化
   * 滑杆位置与回显。连接就绪才拉；失败静默（保持上次值）。 */
  fetchDiagPrefs: function () {
    const snap = ble.getProtocolSnapshot();
    const cfg = snap && snap.status && snap.status.config &&
      snap.status.config.benchtst;
    if (!cfg) return;
    const set = {};
    if (typeof cfg.bl50_pwm === 'number' && cfg.bl50_pwm >= 0 && cfg.bl50_pwm <= 100) {
      set.diagBl50Pwm = cfg.bl50_pwm;
    }
    if (typeof cfg.ibt2_pwm === 'number' && cfg.ibt2_pwm >= 0 && cfg.ibt2_pwm <= 100) {
      set.diagIbt2Pwm = cfg.ibt2_pwm;
    }
    if (typeof cfg.act_duration_ms === 'number' && cfg.act_duration_ms > 0) {
      set.diagActDurMs = Math.min(10000, cfg.act_duration_ms);
    }
    this.setData(set);
  },

  /* 滑杆拖动：实时更新 UI + 延迟（防抖）下发 set_diag_prefs 到固件 */
  /* 滑杆拖动中：实时更新 UI + 防抖下发到固件 */
  onDiagPrefChanging: function (e) {
    const key = e.currentTarget.dataset.key;
    const val = Number(e.detail.value);
    if (key === 'bl50_pwm') this.setData({ diagBl50Pwm: val });
    else if (key === 'ibt2_pwm') this.setData({ diagIbt2Pwm: val });
    else if (key === 'act_ms') this.setData({ diagActDurMs: val });
    this.applyDiagPrefs();
  },

  onDiagPrefChange: function (e) {
    this.onDiagPrefChanging(e);
  },

  applyDiagPrefs: function () {
    if (this._diagPrefsTimer) clearTimeout(this._diagPrefsTimer);
    const self = this;
    this._diagPrefsTimer = setTimeout(() => {
      if (!this.data.bleConnected) {
        self.setData({ diagPrefsStatus: '未连接，参数仅本地生效' });
        return;
      }
      ble.sendProtocolCommand('set_diag_prefs', {
        bl50_pwm: this.data.diagBl50Pwm,
        ibt2_pwm: this.data.diagIbt2Pwm,
        act_duration_ms: this.data.diagActDurMs
      }, { timeoutMs: 3000, retries: 1 })
        .then((ack) => {
          self.setData({ diagPrefsStatus: ack && ack.ok ? '参数已生效' : '参数下发被拒（' + ((ack && ack.code) || '?') + '）' });
        })
        .catch(() => { self.setData({ diagPrefsStatus: '参数下发失败（未连接/超时）' }); });
    }, 350);
  },

  /* 设为默认值：把当前滑杆值写进固件 NVS（重启保留）。 */
  setDiagPrefsAsDefault: function () {
    const self = this;
    if (!this.data.bleConnected) {
      wx.showToast({ title: '未连接', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '写入默认…' });
    ble.sendProtocolCommand('set_diag_prefs', {
      bl50_pwm: this.data.diagBl50Pwm,
      ibt2_pwm: this.data.diagIbt2Pwm,
      act_duration_ms: this.data.diagActDurMs
    }, { timeoutMs: 3000, retries: 1 })
      .then(() => { wx.hideLoading(); self.fetchDiagPrefs(); self.setData({ diagPrefsStatus: '默认参数已写入（重启后生效）' }); wx.showToast({ title: '已写入默认', icon: 'success' }); })
      .catch(() => { wx.hideLoading(); self.setData({ diagPrefsStatus: '写入失败：请重试' }); wx.showToast({ title: '写入失败', icon: 'none' }); });
  },

  /* 恢复出厂默认值：重置 NVS 中的板测诊断参数。 */
  resetDiagPrefs: function () {
    const self = this;
    wx.showModal({
      title: '恢复默认参数',
      content: '将把搅动/换位转速、执行器时长重置为出厂默认（40% / 80% / 1.5s），并写入 NVS。',
      confirmText: '确认恢复',
      success: (res) => {
        if (!res.confirm) return;
        ble.sendProtocolCommand('reset_diag_prefs', {}, { timeoutMs: 3000, retries: 1 })
          .then(() => {
            self.setData({ diagBl50Pwm: 40, diagIbt2Pwm: 80, diagActDurMs: 1500, diagPrefsStatus: '已恢复出厂默认' });
            this.syncDiagnosticsFromSnapshot();
            this.fetchDiagWord();
            wx.showToast({ title: '已恢复', icon: 'success' });
          })
          .catch(() => { self.setData({ diagPrefsStatus: '恢复失败：请重试' }); wx.showToast({ title: '恢复失败', icon: 'none' }); });
      }
    });
  },

  /* 主动 get_status 刷新一次，把预值重新读回来（用于写默认后同步） */
  fetchDiagWord: function () {
    const self = this;
    ble.sendProtocolCommand('get_status', {}, { retries: 0 })
      .catch(() => {})
      .then(() => self.fetchDiagPrefs());
  },

  handleProtocolMessage: function (message) {
    if (!message || message.v !== 1) return;

    if (message.type === 'capabilities') {
      this.setData({
        protocolReady: true,
        diagCapSeen: true,
        ...diagFlagsFromCapabilities(message, this.data.diagMbType)
      });
      return;
    }
    if (message.type !== 'status') return;

    const stateNames = [
      '启动中', '空闲', '等待放入衣物', '清洗运行中', '等待取出衣物',
      'UV 消毒中', '已暂停', '安全复位中', '设备故障'
    ];
    const phaseNames = [
      '空闲', '滚筒定位', 'BL50 归位', '源水进水', '转移进水',
      '投放洗涤剂', '波轮洗', '滚筒洗', '排水', '脱水', '烘干', 'UV', '完成'
    ];
    const state = Number(message.state);
    const phase = Number(message.phase);
    const progress = Math.max(0, Math.min(100, Number(message.progress) || 0));
    const active = state >= 2 && state <= 7;
    const previousProgramId = this.data.activeProgramId;
    const programId = Number(message.program_id) || previousProgramId || 0;
    const remaining = progress < 100
      ? Math.max(Math.ceil(this.data.totalTime * (100 - progress) / 100), 0)
      : 0;

    this.clearProgressTimer();
    this.setData({
      protocolReady: true,
      machineState: state,
      machinePhase: phase,
      deviceStatus: stateNames[state] || `未知状态(${state})`,
      statusText: state === 3
        ? (phaseNames[phase] || stateNames[state])
        : (stateNames[state] || `未知状态(${state})`),
      isWashing: active,
      awaitingLoad: state === 2,
      awaitingUnload: state === 4,
      canSkipUv: state === 5,
      progress: progress,
      remainingTime: remaining,
      useRealProgress: true,
      faultCode: Number(message.fault_code) || 0,
      faultDetail: Number(message.fault_detail) || 0,
      activeProgramId: programId
    });

    /* 热风冷却倒计时：以固件权威 cooldown 剩余 ms 为准（每次 status 推送
     * 重新同步；本地每秒递减保持显示，0 则清除）。 */
    if (message.actuator_self_test) {
      this.syncActCooldown(message.actuator_self_test.cd);
    }

    /* 电机空载台架：同步运行状态快照（st/pos/ready/step/steps/term/off）。 */
    if (message.motor_bench) {
      this.syncMotorBench(message.motor_bench);
    }

    if (state === 8) {
      wx.showToast({ title: `设备故障 ${message.fault_code}`, icon: 'none' });
    }

    if (state === 1 && previousProgramId && progress >= 100 &&
        this._completionHandledProgramId !== previousProgramId) {
      this._completionHandledProgramId = previousProgramId;
      this.onWashComplete();
    }
  },

  refreshDeviceStatus: function () {
    if (!this.data.bleConnected) return Promise.resolve(null);
    return ble.sendProtocolCommand('get_status', {}, { retries: 1 })
      .catch(error => {
        console.warn('[BLE] get_status failed:', error);
        return null;
      });
  },

  syncBleConnectionInfo: function (info, deviceName) {
    const name = deviceName || this.data.bleDeviceName ||
      app.globalData.bleDeviceName || '';
    this.setData({
      bleConnected: true,
      protocolReady: true,
      reconnecting: false,
      bleDeviceId: info.deviceId || this.data.bleDeviceId,
      bleDeviceName: name,
      bleServiceId: info.serviceId || this.data.bleServiceId,
      bleWriteCharId: info.writeCharId || this.data.bleWriteCharId,
      bleNotifyCharId: info.notifyCharId || this.data.bleNotifyCharId,
      bleRSSI: info.RSSI ? info.RSSI + 'dBm' : this.data.bleRSSI
    });
    app.globalData.bleConnected = true;
    app.globalData.bleDeviceId = info.deviceId || this.data.bleDeviceId;
    app.globalData.bleDeviceName = name;
    app.globalData.bleServiceId = info.serviceId || this.data.bleServiceId;
    app.globalData.bleWriteCharId = info.writeCharId || this.data.bleWriteCharId;
    app.globalData.bleNotifyCharId = info.notifyCharId || this.data.bleNotifyCharId;
    ble.rememberDevice(
      info.deviceId || this.data.bleDeviceId,
      name
    );
  },

  resolveDeviceByName: function (targetName) {
    const pickDevice = devices => {
      const candidates = (devices || []).filter(item =>
        item && item.deviceId && item.name &&
        String(item.name).startsWith(ble.DEVICE_NAME_PREFIX)
      );
      const matched = targetName
        ? candidates.find(item => item.name === targetName)
        : candidates.slice().sort((a, b) =>
            (Number(b.RSSI) || -999) - (Number(a.RSSI) || -999)
          )[0];
      if (!matched) {
        throw new Error(targetName
          ? `未发现设备 ${targetName}`
          : '附近未发现小净设备');
      }
      return matched;
    };

    return ble.scanDevices(2500)
      .then(pickDevice)
      .catch(firstError => {
        // A previous mini-program preview can leave an OS-level BLE link alive
        // while this JavaScript context has no connection state. The ESP32 then
        // stops advertising, so a normal scan returns nothing. Resetting the
        // adapter releases that orphaned link and makes the ESP32 advertise again.
        wx.showLoading({ title: '正在恢复蓝牙...' });
        return ble.resetAdapterForRecovery()
          .then(() => ble.scanDevices(6000))
          .then(pickDevice)
          .catch(secondError => {
            console.warn('[BLE] recovery scan failed:', firstError, secondError);
            throw secondError;
          });
      });
  },

  ensureBleReadyForCommand: function (orderData) {
    const snapshot = ble.getProtocolSnapshot();
    if (snapshot.connected && snapshot.protocolReady && snapshot.deviceId) {
      this.syncBleConnectionInfo(snapshot, this.data.bleDeviceName ||
        orderData.deviceName || app.globalData.bleDeviceName);
      orderData.bleDeviceId = snapshot.deviceId;
      orderData.deviceName = this.data.bleDeviceName || orderData.deviceName ||
        app.globalData.bleDeviceName;
      orderData.deviceId = orderData.deviceName || orderData.deviceId;
      return Promise.resolve(snapshot);
    }

    const dataDeviceId = this.data.bleDeviceId || orderData.bleDeviceId ||
      app.globalData.bleDeviceId || orderData.deviceId || '';
    const dataDeviceName = this.data.bleDeviceName || orderData.deviceName ||
      app.globalData.bleDeviceName || '';
    const idLooksLikeName = dataDeviceId &&
      String(dataDeviceId).startsWith(ble.DEVICE_NAME_PREFIX);
    const idLooksLikeCloudId = dataDeviceId &&
      String(dataDeviceId).startsWith('device_');

    const connectResolved = (device) => {
      const deviceId = typeof device === 'string' ? device : device.deviceId;
      const deviceName = typeof device === 'string' ? dataDeviceName : device.name;
      return ble.connectDevice(deviceId).then(info => {
        this.syncBleConnectionInfo(info, deviceName);
        orderData.bleDeviceId = info.deviceId || deviceId;
        orderData.deviceName = deviceName || orderData.deviceName;
        orderData.deviceId = orderData.deviceName || orderData.deviceId;
        return info;
      });
    };

    if (!isRealBleDeviceId(dataDeviceId) || idLooksLikeName || idLooksLikeCloudId) {
      const targetName = idLooksLikeName ? dataDeviceId : dataDeviceName;
      return this.resolveDeviceByName(targetName).then(connectResolved);
    }

    return connectResolved(dataDeviceId).catch(error => {
      console.warn('[BLE] saved device id failed, falling back to discovery:', error);
      return this.resolveDeviceByName(dataDeviceName).then(connectResolved);
    });
  },

  warmBleConnection: function () {
    const snapshot = ble.getProtocolSnapshot();
    if (snapshot.connected && snapshot.protocolReady && snapshot.deviceId) {
      return Promise.resolve(snapshot);
    }
    if (this._bleWarmupInFlight) return this._bleWarmupInFlight;

    const remembered = ble.getRememberedDevice();
    const deviceId = this.data.bleDeviceId || app.globalData.bleDeviceId ||
      (remembered && remembered.deviceId) || '';
    const deviceName = this.data.bleDeviceName || app.globalData.bleDeviceName ||
      (remembered && remembered.deviceName) || '';
    if (!isRealBleDeviceId(deviceId)) return Promise.resolve(null);

    this._bleWarmupInFlight = ble.connectDevice(deviceId)
      .then(info => {
        if (this._pageAlive) this.syncBleConnectionInfo(info, deviceName);
        return info;
      })
      .catch(error => {
        console.warn('[BLE] background warm-up failed; foreground recovery remains available:', error);
        return null;
      })
      .finally(() => {
        this._bleWarmupInFlight = null;
      });
    return this._bleWarmupInFlight;
  },

  connectBLE: function () {
    if (!this.data.bleDeviceId && !this.data.bleDeviceName) {
      wx.showToast({ title: '请先选择设备', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '蓝牙连接中...' });

    const connectionOrder = {
      bleDeviceId: this.data.bleDeviceId,
      deviceId: this.data.bleDeviceName || this.data.bleDeviceId,
      deviceName: this.data.bleDeviceName
    };
    this.ensureBleReadyForCommand(connectionOrder)
      .then((info) => {
        wx.hideLoading();
        this.syncBleConnectionInfo(info, this.data.bleDeviceName);

        wx.showToast({ title: '蓝牙连接成功', icon: 'success' });
        this.refreshDeviceStatus();
        this.syncDiagnosticsFromSnapshot();
        this.openDiagIfNotConnected();
      })
      .catch((err) => {
        wx.hideLoading();
        console.error('连接失败:', err);
        wx.showToast({ title: '连接失败，请重试', icon: 'none' });
      });
  },

  loadAndStartBooking: function (bookingId) {
    if (!bookingId) {
      this.setData({ commandBusy: false, _startNow: false });
      wx.showModal({
        title: '预约订单无效',
        content: '缺少预约订单 ID，请返回预约页刷新后重试。',
        showCancel: false
      });
      return;
    }

    this.setData({
      commandBusy: true,
      _startNow: true,
      statusText: '正在加载预约订单...'
    });

    wx.cloud.callFunction({
      name: 'getOrderById',
      data: { orderId: bookingId }
    }).then(res => {
      const result = res && res.result;
      const order = result && result.data && result.data.order;
      if (!result || result.code !== 0 || !order) {
        throw new Error((result && result.msg) || '预约订单不存在');
      }
      if (!['已预约', '启动待确认', '启动失败'].includes(order.status)) {
        throw new Error(`订单状态 ${order.status || '未知'} 不允许再次启动`);
      }
      if (order.bookingDate && order.bookingTime) {
        const startAt = new Date(`${order.bookingDate}T${order.bookingTime}:00`);
        if (!Number.isNaN(startAt.getTime()) && startAt.getTime() > Date.now()) {
          throw new Error('预约时间未到');
        }
      }

      const selectedPackage = order.package === 'dry' ? 'dry' : 'quick';
      const customSteps = normalizeBookingSteps(order.steps);
      this.setData({
        selectedPackage,
        packageBasePrice: selectedPackage === 'dry' ? 2 : 1,
        customSteps,
        // 预约订单恢复：必须恢复原订单 allowUv，旧订单缺失时按 false。
        uvDisinfectionEnabled: order.allowUv === true,
        totalTime: Number(order.totalTime) || 0,
        totalPrice: Number(order.totalPrice) || 0,
        finalPrice: Number(order.finalPrice) || 0,
        selectedCouponId: '',
        isBooking: false,
        _sourceBookingId: bookingId,
        _currentOrderId: bookingId,
        bleDeviceName: this.data.bleDeviceName || order.deviceName ||
          order.deviceId || '',
        statusText: '正在连接预约设备...'
      });
      this.submitOrder();
    }).catch(error => {
      console.error('加载预约订单失败:', error);
      this.setData({
        commandBusy: false,
        _startNow: false,
        _sourceBookingId: '',
        statusText: '预约订单加载失败'
      });
      wx.showModal({
        title: '无法启动预约',
        content: error.message || '预约订单加载失败，请重试。',
        showCancel: false
      });
    });
  },

  disconnectBLE: function () {
    ble.clearReconnectState(); // 用户主动断开，不触发自动重连
    this.stopAutoReconnect();  // 同时停止 AI 重连
    ble.disconnect();
    this.setData({
      bleConnected: false,
      bleDeviceId: '',
      bleDeviceName: '',
      bleServiceId: '',
      bleWriteCharId: '',
      bleNotifyCharId: '',
      protocolReady: false,
      reconnecting: false
    });
    app.globalData.bleConnected = false;
    app.globalData.bleDeviceId = '';
    app.globalData.bleServiceId = '';
    app.globalData.bleWriteCharId = '';
    app.globalData.bleNotifyCharId = '';
  },

  toggleConnection: function () {
    if (this.data.bleConnected) {
      this.disconnectBLE();
    } else {
      this.switchDevice();
    }
  },

  // ========== AI 状态机（从 3.2 迁移，对接 ESP32 语音 AI） ==========

  handleAiStatus: function (msg) {
    const phase = msg.phase || 'unknown';
    const now = Date.now();

    const isIdle = phase === 'idle';
    const isDone = phase === 'result_ready' || phase === 'ble_resume_done';
    const isFailed = phase === 'cloud_failed' || msg.cloud_error;

    const aiProcessing = !(isIdle || isDone || isFailed);
    const expectedDisconnect = phase === 'ble_suspending'
      ? true
      : (phase === 'idle' || phase === 'ble_resume_done' ? false : this.data.expectedDisconnect);

    this.setData({
      lastAiStatus: msg,
      currentAiSeq: msg.seq || this.data.currentAiSeq,
      aiProcessing,
      expectedDisconnect,
      lastAiStatusAt: now
    });

    console.log('[AI_STATUS]', phase, 'seq=' + msg.seq, 'aiProcessing=' + aiProcessing, 'expectedDisconnect=' + expectedDisconnect);

    if (phase === 'ble_suspending') {
      wx.showToast({
        title: 'AI处理中，蓝牙将短暂断开',
        icon: 'none',
        duration: 2500
      });
    }

    if (phase === 'ble_resume_done') {
      this.stopAutoReconnect();
      this.setData({
        reconnecting: false,
        expectedDisconnect: false,
        aiProcessing: false
      });
      wx.showToast({
        title: '设备已重连',
        icon: 'success',
        duration: 1500
      });
    }

    if (isFailed) {
      this.stopAutoReconnect();
      this.setData({
        aiProcessing: false,
        expectedDisconnect: false,
        reconnecting: false
      });
      wx.showToast({
        title: 'AI处理失败，请重试',
        icon: 'none',
        duration: 2500
      });
    }
  },

  startAutoReconnect: function () {
    if (this.aiReconnectTimer) return;

    const deviceId = this.data.bleDeviceId;
    if (!deviceId) {
      this.setData({ reconnecting: false });
      wx.showToast({ title: '缺少设备信息，请手动重连', icon: 'none' });
      return;
    }

    this.aiReconnectStopped = false;
    this.setData({ reconnecting: true, reconnectAttempts: 0 });

    const tryReconnect = () => {
      if (this.aiReconnectStopped) return;

      const attempts = this.data.reconnectAttempts || 0;
      if (attempts >= this.data.maxReconnectAttempts) {
        this.stopAutoReconnect();
        this.setData({ reconnecting: false, expectedDisconnect: false });
        wx.showToast({ title: '重连超时，请手动重新连接', icon: 'none' });
        return;
      }

      this.setData({ reconnectAttempts: attempts + 1 });
      console.log('[RECONNECT] attempt', attempts + 1, '/', this.data.maxReconnectAttempts);

      ble.connectDevice(deviceId)
        .then((info) => {
          this.stopAutoReconnect();
          this.setData({
            bleConnected: true,
            reconnecting: false,
            expectedDisconnect: false,
            bleDeviceId: info.deviceId || deviceId,
            bleServiceId: info.serviceId,
            bleWriteCharId: info.writeCharId,
            bleNotifyCharId: info.notifyCharId
          });
          app.globalData.bleConnected = true;
          app.globalData.bleDeviceId = info.deviceId || deviceId;
          app.globalData.bleServiceId = info.serviceId;
          app.globalData.bleWriteCharId = info.writeCharId;
          app.globalData.bleNotifyCharId = info.notifyCharId;
          wx.showToast({ title: '设备已重连，正在同步状态', icon: 'none', duration: 2000 });
        })
        .catch(() => {
          if (!this.aiReconnectStopped) {
            this.aiReconnectTimer = setTimeout(tryReconnect, 2000);
          }
        });
    };

    tryReconnect();
  },

  stopAutoReconnect: function () {
    this.aiReconnectStopped = true;
    if (this.aiReconnectTimer) {
      clearTimeout(this.aiReconnectTimer);
      this.aiReconnectTimer = null;
    }
  },

  selectPackage: function (e) {
    const pkg = e.currentTarget.dataset.package;
    let basePrice = 0;

    if (pkg === 'quick') {
      basePrice = 1;
      this.setData({
        selectedPackage: pkg,
        packageBasePrice: basePrice,
        customSteps: {
          soak:  { enabled: true, count: 1, time: 5, price: 0 },
          wash:  { enabled: true, count: 2, time: 5, price: 0 },
          rinse: { enabled: true, count: 3, time: 5, price: 0 },
          dry:   { enabled: false, count: 0, time: 20, price: 1 }
        }
      });
    } else if (pkg === 'dry') {
      basePrice = 2;
      this.setData({
        selectedPackage: pkg,
        packageBasePrice: basePrice,
        customSteps: {
          soak:  { enabled: true, count: 1, time: 5, price: 0 },
          wash:  { enabled: true, count: 2, time: 5, price: 0 },
          rinse: { enabled: true, count: 3, time: 5, price: 0 },
          dry:   { enabled: true, count: 1, time: 20, price: 1 }
        }
      });
    }
    this.calculateTotal();
  },

  increaseStep: function (e) {
    const step = e.currentTarget.dataset.step;
    // 深拷贝避免直接修改 this.data
    const steps = JSON.parse(JSON.stringify(this.data.customSteps));
    if (steps[step]) {
      if (steps[step].count >= 10) {
        wx.showToast({ title: '最多10次', icon: 'none' });
        return;
      }
      steps[step].count += 1;
      steps[step].enabled = true;
      this.setData({ customSteps: steps });
      this.calculateTotal();
    }
  },

  decreaseStep: function (e) {
    const step = e.currentTarget.dataset.step;
    // 深拷贝避免直接修改 this.data
    const steps = JSON.parse(JSON.stringify(this.data.customSteps));

    if (step === 'rinse' && steps.rinse.count <= 3) {
      wx.showToast({ title: '漂洗最少3轮', icon: 'none' });
      return;
    }
    if (steps[step] && steps[step].count > 0) {
      steps[step].count -= 1;
      if (steps[step].count === 0 && step !== 'dry') {
        steps[step].enabled = false;
      }
      this.setData({ customSteps: steps });
      this.calculateTotal();
    }
  },

  toggleStep: function (e) {
    const step = e.currentTarget.dataset.step;
    // 深拷贝避免直接修改 this.data
    const steps = JSON.parse(JSON.stringify(this.data.customSteps));
    if (steps[step]) {
      steps[step].enabled = !steps[step].enabled;
      if (steps[step].enabled) {
        steps[step].count = step === 'rinse' ? 3 : 1;
      } else if (step !== 'dry') {
        steps[step].count = 0;
      }
      this.setData({ customSteps: steps });
      this.calculateTotal();
    }
  },

  loadCoupons: function () {
    this.setData({ couponLoading: true });
    wx.cloud.callFunction({
      name: 'getUserCoupons',
      data: {}
    }).then(res => {
      if (res.result.code === 0) {
        const coupons = res.result.data.coupons || [];
        this.setData({ coupons });
      }
    }).catch(err => {
      console.error('加载优惠券失败:', err);
      wx.showToast({ title: '优惠券加载失败', icon: 'none' });
    }).finally(() => {
      this.setData({ couponLoading: false });
    });
  },

  selectCoupon: function (e) {
    const id = e.currentTarget.dataset.id || '';
    const same = this.data.selectedCouponId === id;
    // 如果点击已选中的则取消选择
    this.setData({ selectedCouponId: same ? '' : id });
    this.calculateTotal();
  },

  calculateTotal: function () {
    const steps = this.data.customSteps;
    let totalTime = 0;
    let addonPrice = 0;

    Object.keys(steps).forEach(key => {
      if (steps[key].enabled) {
        totalTime += steps[key].count * steps[key].time;
        addonPrice += steps[key].count * steps[key].price;
      }
    });

    // 总价 = 套餐基础价 + 附加项价格（烘干等）
    const totalPrice = this.data.packageBasePrice + addonPrice;
    let finalPrice = totalPrice;

    // 优惠券抵扣
    const selectedCoupon = this.data.coupons.find(c => c.id === this.data.selectedCouponId);
    if (selectedCoupon && totalPrice > 0) {
      this.setData({ _discountValue: selectedCoupon.value || 1 });
      finalPrice = Math.max(0, totalPrice - (selectedCoupon.value || 1));
    } else {
      this.setData({ _discountValue: 0 });
    }

    this.setData({ totalTime, totalPrice, finalPrice });

    // 如果开启了预约，更新预计完成时间
    if (this.data.isBooking) {
      this.calculateEndTime();
    }
  },

  switchDevice: function () {
    wx.navigateTo({ url: '/pages/devices/devices?from=wash' });
  },

  goHome: function () {
    wx.switchTab({ url: '/pages/home/home' });
  },

  // ========== 提交订单（支持预约） ==========
  submitOrder: function () {
    const orderData = {
      deviceId: this.data.bleDeviceName || this.data.bleDeviceId,
      deviceName: this.data.bleDeviceName || this.data.bleDeviceId,
      bleDeviceId: this.data.bleDeviceId,
      package: this.data.selectedPackage,
      steps: this.data.customSteps,
      totalTime: this.data.totalTime,
      totalPrice: this.data.totalPrice,
      finalPrice: this.data.finalPrice,
      couponId: this.data.selectedCouponId,
      clientRequestId: this._clientRequestId || makeClientRequestId(),
      // UV 附加项持久字段。旧订单缺少该字段时按 false 处理。
      allowUv: this.data.uvDisinfectionEnabled === true,

      isBooking: this.data.isBooking,
      bookingDate: this.data.bookingDate,
      bookingTime: this.data.bookingTime,
      startTime: this.data.isBooking ? `${this.data.bookingDate} ${this.data.bookingTime}` : '立即',
      endTime: this.data.isBooking ? this.data.endTimePreview : ''
    };

    if (orderData.isBooking) {
      this.createBooking(orderData);
    } else if (this.data._startNow) {
      this.setData({ _startNow: false });
      this.startWashViaBLE(orderData);
    } else {
      // 立即清洗：允许用户在尚未手动连接时提交。先自动发现并完成
      // BLE 握手，确认设备真实可用后再支付和创建订单。
      this.prepareImmediateOrder(orderData);
    }
  },

  prepareImmediateOrder: function (orderData) {
    if (this.data.commandBusy) return;

    const startImmediateOrder = () => {
      this.setData({
        commandBusy: true,
        statusText: '正在提交即时订单并启动设备...'
      });
      // Immediate mode is intentionally a one-click path. startWashViaBLE()
      // performs a final protocol-ready check, saves a non-booking order, and
      // sends start_formal. Payment remains outside the current device bring-up
      // flow and must never force the user through the booking path.
      this.startWashViaBLE(orderData);
    };

    const snapshot = ble.getProtocolSnapshot();
    if (snapshot.connected && snapshot.protocolReady && snapshot.deviceId) {
      this.syncBleConnectionInfo(
        snapshot,
        this.data.bleDeviceName || orderData.deviceName ||
          app.globalData.bleDeviceName
      );
      orderData.bleDeviceId = snapshot.deviceId;
      orderData.deviceName = this.data.bleDeviceName || orderData.deviceName ||
        app.globalData.bleDeviceName || 'JJTP-XIAOJING';
      orderData.deviceId = orderData.deviceName;
      startImmediateOrder();
      return;
    }

    const knownDeviceId = this.data.bleDeviceId || orderData.bleDeviceId ||
      app.globalData.bleDeviceId || '';
    this.setData({ commandBusy: true });
    wx.showLoading({
      title: isRealBleDeviceId(knownDeviceId)
        ? '正在确认设备连接...'
        : '正在查找设备...'
    });
    this.ensureBleReadyForCommand(orderData)
      .then(() => {
        wx.hideLoading();
        startImmediateOrder();
      })
      .catch(error => {
        wx.hideLoading();
        this.setData({ commandBusy: false });
        console.error('立即下单前连接设备失败:', error);
        wx.showModal({
          title: '未找到可用设备',
          content: error.message || '请靠近小净设备并确认手机蓝牙已开启。',
          showCancel: false
        });
      });
  },

  // ========== 支付流程 ==========
  doPayment: function (orderData) {
    wx.showLoading({ title: '发起支付...' });

    wx.cloud.callFunction({
      name: 'createPayment',
      data: {
        orderId: 'temp_' + Date.now(),
        totalFee: orderData.finalPrice,
        body: '净界同频-' + (orderData.package === 'quick' ? '快洗' : '烘干')
      }
    }).then(res => {
      wx.hideLoading();

      if (res.result.code !== 0) {
        wx.showToast({ title: res.result.msg || '支付失败', icon: 'none' });
        return;
      }

      const payData = res.result.data;

      // 开发模式：模拟支付直接成功
      if (payData.isMock) {
        wx.showToast({ title: '支付成功（模拟）', icon: 'success' });
        // 请求订阅消息授权
        this.requestSubscribe();
        this.startWashViaBLE(orderData);
        return;
      }

      // 真实微信支付
      wx.requestPayment({
        timeStamp: payData.timeStamp,
        nonceStr: payData.nonceStr,
        package: payData.package,
        signType: payData.signType || 'MD5',
        paySign: payData.paySign,
        success: () => {
          wx.showToast({ title: '支付成功', icon: 'success' });
          this.requestSubscribe();
          this.startWashViaBLE(orderData);
        },
        fail: (err) => {
          console.error('支付失败:', err);
          if (err.errMsg && err.errMsg.includes('cancel')) {
            wx.showToast({ title: '已取消支付', icon: 'none' });
          } else {
            wx.showToast({ title: '支付失败，请重试', icon: 'none' });
          }
        }
      });
    }).catch(err => {
      wx.hideLoading();
      console.error('支付请求失败:', err);
      wx.showToast({ title: '网络错误', icon: 'none' });
    });
  },

  // ========== 预约相关方法 ==========

  toggleUvDisinfection: function (e) {
    this.setData({ uvDisinfectionEnabled: e.detail.value === true });
  },

  // ========== 开发测试：UV 灯安全自检（仅诊断，不创建订单） ==========

  toggleDiagSection: function () {
    this.setData({ diagExpanded: !this.data.diagExpanded });
  },

  runUvSelfTest: function () {
    if (this.data.diagSelftestBusy) return;
    // 高风险二次确认：遮挡 UV 灯 + 0° 对齐 + 电机停止
    wx.showModal({
      title: 'UV 灯安全自检',
      content: '请遮挡 UV 灯，严禁直视。\n确认桶位于 0° 对齐位置且电机停止。',
      confirmText: '开始自检',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) this.sendUvSelfTest();
      }
    });
  },

  sendUvSelfTest: function () {
    if (this.data.diagSelftestBusy) return;
    if (!this.data.bleConnected || !this.data.protocolReady) {
      this.setData({
        diagSelftestPhase: 'unknown',
        diagSelftestStatus: '自检状态未知：蓝牙未连接'
      });
      return;
    }
    this.stopDiagPoll();
    this.setData({
      diagSelftestBusy: true,
      diagSelftestPhase: 'checking',
      diagSelftestStatus: '正在检查安全条件'
    });
    ble.sendProtocolCommand('uv_self_test', {}, { timeoutMs: 5000, retries: 0 })
      .then(ack => {
        if (ack && ack.ok && ack.code === 'UV_SELF_TEST_ACCEPTED') {
          const durationSec = Math.max(1, Math.round((Number(ack.duration_ms) || 3000) / 1000));
          this.setData({
            diagSelftestPhase: 'accepted',
            diagSelftestStatus: `UV 自检已受理（约 ${durationSec} 秒）`
          });
          this.pollUvSelfTest();
        } else {
          const code = ack && ack.code;
          this.setData({
            diagSelftestPhase: 'rejected',
            diagSelftestBusy: false,
            diagSelftestStatus: this.mapDiagReject(code)
          });
        }
      })
      .catch(error => {
        const code = error && (error.code || error.errCode);
        this.setData({
          diagSelftestPhase: 'rejected',
          diagSelftestBusy: false,
          diagSelftestStatus: this.mapDiagReject(code)
        });
      });
  },

  mapDiagReject: function (code) {
    const map = {
      MACHINE_NOT_IDLE: '被拒绝：设备不在空闲状态',
      UV_BUSY: '被拒绝：UV 自检正在进行',
      POSITION_UNKNOWN: '被拒绝：位置状态无效',
      POSITION_STALE: '被拒绝：位置状态已过期',
      POSITION_UNSTABLE: '被拒绝：位置不稳定',
      POSITION_NOT_ZERO: '被拒绝：桶位置不是 0°',
      MOTOR_MOVING: '被拒绝：电机正在运动',
      FAULT_ACTIVE: '被拒绝：设备存在故障',
      EMERGENCY_ACTIVE: '被拒绝：设备处于急停状态',
      MCP_UNKNOWN: '被拒绝：MCP 输出状态未知',
      UV_NOT_CONFIRMED_OFF: '被拒绝：UV 未确认关闭',
      WATER_SNAPSHOT_UNAVAILABLE: '被拒绝：进水服务状态不可用',
      DETERGENT_SNAPSHOT_UNAVAILABLE: '被拒绝：洗涤剂服务状态不可用',
      DRAIN_SNAPSHOT_UNAVAILABLE: '被拒绝：排水服务状态不可用',
      DRY_SNAPSHOT_UNAVAILABLE: '被拒绝：烘干服务状态不可用',
      NOT_SUPPORTED: '被拒绝：固件不支持自检',
      UV_SUBMIT_FAILED: '提交失败：请检查设备连接'
    };
    return map[code] || `被拒绝：${code || '未知原因'}`;
  },

  pollUvSelfTest: function () {
    this.stopDiagPoll();
    this._diagPollCount = 0;
    const tick = () => {
      if (!this._pageAlive) return;
      /* 主动 get_status 刷新缓存（固件不在自检后自动推送 status）。 */
      ble.sendProtocolCommand('get_status', {}, { retries: 0 })
        .catch(() => {})
        .then(() => {
          if (!this._pageAlive) return;
          const snap = ble.getProtocolSnapshot();
          const status = snap && snap.status;
          const code = Number(status && status.uv_self_test);
          if (code === UV_SELF_TEST_STATUS.RUNNING) {
            this.setData({
              diagSelftestPhase: 'running',
              diagSelftestStatus: 'UV 自检运行中（3 秒），请勿直视'
            });
          } else if (code === UV_SELF_TEST_STATUS.STOPPING) {
            this.setData({
              diagSelftestPhase: 'running',
              diagSelftestStatus: 'UV 正在自动关闭…'
            });
          } else if (code === UV_SELF_TEST_STATUS.COMPLETE) {
            this.setData({
              diagSelftestPhase: 'complete',
              diagSelftestBusy: false,
              diagSelftestStatus: 'UV 已自动关闭'
            });
            return;
          } else if (code === UV_SELF_TEST_STATUS.REJECTED) {
            this.setData({
              diagSelftestPhase: 'rejected',
              diagSelftestBusy: false,
              diagSelftestStatus: '自检被拒绝，请检查安全条件'
            });
            return;
          } else if (code === UV_SELF_TEST_STATUS.FAULT) {
            this.setData({
              diagSelftestPhase: 'fault',
              diagSelftestBusy: false,
              diagSelftestStatus: '关灯失败：请立即断电检查'
            });
            return;
          } else if (code === UV_SELF_TEST_STATUS.INTERRUPTED) {
            this.setData({
              diagSelftestPhase: 'interrupted',
              diagSelftestBusy: false,
              diagSelftestStatus: '自检被中断（已取消/跳过），灯已关闭'
            });
            return;
          } else if (code === UV_SELF_TEST_STATUS.TIMEOUT) {
            this.setData({
              diagSelftestPhase: 'timeout',
              diagSelftestBusy: false,
              diagSelftestStatus: '自检超时结束，灯已关闭'
            });
            return;
          }
          // INACTIVE/VALIDATING/未知：继续轮询（上限 30 次 * 500ms）
          this._diagPollCount = (this._diagPollCount || 0) + 1;
          if (this._diagPollCount > 30) {
            this.setData({
              diagSelftestPhase: 'unknown',
              diagSelftestBusy: false,
              diagSelftestStatus: '自检状态未知：请查看串口日志'
            });
            return;
          }
          this._diagPollTimer = setTimeout(tick, 500);
        });
    };
    this._diagPollTimer = setTimeout(tick, 500);
  },

  stopDiagPoll: function () {
    if (this._diagPollTimer) {
      clearTimeout(this._diagPollTimer);
      this._diagPollTimer = null;
    }
    this._diagPollCount = 0;
  },

  markDiagStatusUnknown: function () {
    // BLE 断开：固件侧仅收到 emergency 关灯请求，未确认 OFF。
    // 文案不得声称"已执行关灯"，只能承诺"已请求，待设备确认"。
    this.stopDiagPoll();
    if (this.data.diagSelftestBusy || this.data.diagSelftestPhase === 'running') {
      this.setData({
        diagSelftestPhase: 'unknown',
        diagSelftestBusy: false,
        diagSelftestStatus: '已请求紧急关灯，状态待设备确认'
      });
    }
  },

  // ========== 执行器板测（开发测试区：阀/泵，仅诊断） ==========

  runActuatorSelftest: function (e) {
    const target = e && e.currentTarget && e.currentTarget.dataset &&
      e.currentTarget.dataset.target;
    const info = ACT_TARGET_INFO[target];
    if (!info) return;
    if (this.data.diagActBusy) return;
    if (!this.data.bleConnected || !this.data.protocolReady) {
      wx.showToast({ title: '蓝牙未连接', icon: 'none' });
      return;
    }
    const self = this;
    wx.showModal({
      title: `执行${info.label}自检`,
      content: info.confirm,
      confirmText: '确认执行',
      cancelText: '取消',
      success: function (res) {
        if (res.confirm) self.sendActuatorSelftest(target);
      }
    });
  },

  sendActuatorSelftest: function (target) {
    const info = ACT_TARGET_INFO[target] || {};
    this.stopActPoll();
    this.setData({
      diagActBusy: true,
      diagActPhase: 'checking',
      diagActTarget: target,
      diagActStatus: '正在检查安全条件'
    });
    ble.sendProtocolCommand('actuator_self_test', { target }, { timeoutMs: 5000, retries: 0 })
      .then(ack => {
        if (ack && ack.ok && ack.code === 'ACTUATOR_SELF_TEST_ACCEPTED') {
          this.setData({
            diagActPhase: 'accepted',
            diagActStatus: `${info.label || ''}自检已受理（${info.durationLabel || ''}）`
          });
          this.pollActuatorSelftest();
        } else {
          const code = ack && ack.code;
          this.setData({
            diagActPhase: 'rejected',
            diagActBusy: false,
            diagActStatus: this.mapActReject(code)
          });
        }
      })
      .catch(error => {
        const code = error && (error.code || error.errCode);
        this.setData({
          diagActPhase: 'rejected',
          diagActBusy: false,
          diagActStatus: this.mapActReject(code)
        });
      });
  },

  mapActReject: function (code) {
    if (code === 'POSITION_NOT_ZERO') {
      return `被拒绝：桶位置未对齐（需 ${this.actRequiredPosText()} 且电机停稳）`;
    }
    const map = {
      EXECUTOR_BUSY: '被拒绝：设备不在空闲状态',
      SELF_TEST_BUSY: '被拒绝：已有自检正在进行',
      FAULT_ACTIVE: '被拒绝：设备存在故障',
      EMERGENCY_ACTIVE: '被拒绝：设备处于急停状态',
      DIRECTION_NOT_CALIBRATED: '被拒绝：电机方向未标定，请先完成方向标定',
      POSITION_UNKNOWN: '被拒绝：位置状态无效',
      POSITION_STALE: '被拒绝：位置状态已过期',
      POSITION_UNSTABLE: '被拒绝：位置不稳定',
      MOTOR_MOVING: '被拒绝：电机正在运动',
      OUTPUT_STATE_UNKNOWN: '被拒绝：输出状态未知',
      OUTPUT_ALREADY_ON: '被拒绝：目标输出未确认关闭',
      CONFLICT_OUTPUT_ON: '被拒绝：互斥输出仍开启',
      SERVICE_BUSY: '被拒绝：水/洗涤剂服务忙',
      REQUEST_ID_INVALID: '被拒绝：请求号无效',
      UNKNOWN_TARGET: '被拒绝：未知自检目标',
      NOT_SUPPORTED: '被拒绝：固件不支持板测',
      HOT_AIR_COOLDOWN_ACTIVE: '被拒绝：热风模块冷却锁定中，请稍候再试',
      HOT_AIR_TEMP_TOO_HIGH: '被拒绝：出口温度过高，请冷却后再试',
      HOT_AIR_SNAPSHOT_UNAVAILABLE: '被拒绝：无法确认热风输出状态',
      ACT_SUBMIT_FAILED: '提交失败：请检查设备连接'
    };
    return map[code] || `被拒绝：${code || '未知原因'}`;
  },

  /* 各执行器板测所需桶位角度（与固件 actuator_self_test required_pos 一致）：
   * 排水泵 180°；风扇/热风模块 270°。线码 POSITION_NOT_ZERO 与 UV 自检同名
   * （UV 真要求 0°），对执行器自检其含义是"未对齐到目标角度"，故文案动态显示角度。 */
  actRequiredPosText: function () {
    switch (this.data.diagActTarget) {
      case 'drain_pump': return '180°';
      case 'fan':
      case 'hot_air_coupled': return '270°';
      default: return '目标角度';
    }
  },

  pollActuatorSelftest: function () {
    this.stopActPoll();
    this._actPollCount = 0;
    const tick = () => {
      if (!this._pageAlive) return;
      /* 主动请求一次 get_status：固件回复 ack 后推送 status，更新缓存快照，
       * 使 actuator_self_test 终态可见（固件不在自检后自动推送 status）。 */
      ble.sendProtocolCommand('get_status', {}, { retries: 0 })
        .catch(() => {})
        .then(() => {
          if (!this._pageAlive) return;
          const snap = ble.getProtocolSnapshot();
          const status = snap && snap.status;
          const act = status && status.actuator_self_test;
          if (!act) {
            this._actPollCount = (this._actPollCount || 0) + 1;
            if (this._actPollCount > 30) {
              this.setData({
                diagActPhase: 'unknown',
                diagActBusy: false,
                diagActStatus: '板测状态未知：请查看串口日志'
              });
              return;
            }
            this._actPollTimer = setTimeout(tick, 500);
            return;
          }
          const st = Number(act.st);
          if (st === ACT_SELF_TEST_STATUS.RUNNING ||
              st === ACT_SELF_TEST_STATUS.CHECKING ||
              st === ACT_SELF_TEST_STATUS.ACCEPTED) {
            this.setData({
              diagActPhase: 'running',
              diagActStatus: '板测运行中，设备端计时自动关闭'
            });
          } else if (st === ACT_SELF_TEST_STATUS.COMPLETE) {
            /* 热风：仅当 output_confirmed_off=true 才显示「已确认关闭」（断线
             * 重连同样适用）；否则只能说明板测完成但未获 OFF 确认。 */
            const hotAir = this.data.diagActTarget === 'hot_air_coupled';
            const offOk = Number(act.off) === 1;
            this.setData({
              diagActPhase: 'complete',
              diagActBusy: false,
              diagActStatus: hotAir
                ? (offOk ? '板测完成，输出已确认关闭' : '板测完成，但输出未确认关闭')
                : '板测完成，输出已确认关闭'
            });
            if (hotAir) this.syncActCooldown(act.cd);
            return;
          } else if (st === ACT_SELF_TEST_STATUS.REJECTED) {
            this.setData({
              diagActPhase: 'rejected',
              diagActBusy: false,
              diagActStatus: '板测被拒绝，请检查安全条件'
            });
            return;
          } else if (st === ACT_SELF_TEST_STATUS.INTERRUPTED) {
            this.setData({
              diagActPhase: 'interrupted',
              diagActBusy: false,
              diagActStatus: '板测被中断（紧急/断线），输出已请求关闭'
            });
            if (this.data.diagActTarget === 'hot_air_coupled') this.syncActCooldown(act.cd);
            return;
          } else if (st === ACT_SELF_TEST_STATUS.TIMEOUT) {
            this.setData({
              diagActPhase: 'timeout',
              diagActBusy: false,
              diagActStatus: '板测超时结束，输出已请求关闭'
            });
            if (this.data.diagActTarget === 'hot_air_coupled') this.syncActCooldown(act.cd);
            return;
          } else if (st === ACT_SELF_TEST_STATUS.FAULT) {
            /* off=1 表示输出已确认关闭；off=0 表示输出未确认关闭（危险）。 */
            this.setData({
              diagActPhase: 'fault',
              diagActBusy: false,
              diagActStatus: Number(act.off) === 1
                ? '板测故障：请检查串口日志'
                : '板测故障（输出未确认关闭）：请立即断电检查'
            });
            if (this.data.diagActTarget === 'hot_air_coupled') this.syncActCooldown(act.cd);
            return;
          }
          // INACTIVE/未知：继续轮询（上限 30 次 * 500ms）
          this._actPollCount = (this._actPollCount || 0) + 1;
          if (this._actPollCount > 30) {
            this.setData({
              diagActPhase: 'unknown',
              diagActBusy: false,
              diagActStatus: '板测状态未知：请查看串口日志'
            });
            return;
          }
          this._actPollTimer = setTimeout(tick, 500);
        });
    };
    this._actPollTimer = setTimeout(tick, 500);
  },

  stopActPoll: function () {
    if (this._actPollTimer) {
      clearTimeout(this._actPollTimer);
      this._actPollTimer = null;
    }
    this._actPollCount = 0;
  },

  markActStatusUnknown: function () {
    this.stopActPoll();
    if (this.data.diagActBusy || this.data.diagActPhase === 'running') {
      /* 热风模块：单继电器高压输出，断线后只能承诺「已请求紧急关断，
       * 等待设备确认」，重连后仅当 output_confirmed_off=true 才显示已确认。 */
      const hotAir = this.data.diagActTarget === 'hot_air_coupled';
      this.setData({
        diagActPhase: 'unknown',
        diagActBusy: false,
        diagActStatus: hotAir
          ? '已请求紧急关断，等待设备确认'
          : '已请求紧急关闭，状态待设备确认'
      });
    }
  },

  /* ---- 热风模块冷却倒计时（固件权威 cooldown ms） ---- */

  syncActCooldown: function (cdMs) {
    const cd = Number(cdMs) || 0;
    if (cd <= 0) {
      if (this.data.diagActCooldownMs > 0) {
        this.stopActCooldown();
        this.setData({ diagActCooldownMs: 0, diagActCooldownText: '' });
      }
      return;
    }
    const current = this.data.diagActCooldownMs;
    /* 权威值更大或首次出现才重新同步，避免每次 status 推送把本地倒计时重置。 */
    if (current === 0 || cd > current) {
      this.stopActCooldown();
      this.setData({
        diagActCooldownMs: cd,
        diagActCooldownText: `热风冷却中：约 ${Math.ceil(cd / 1000)} 秒后重试`
      });
      this._runActCooldownCountdown();
    }
  },

  _runActCooldownCountdown: function () {
    const self = this;
    this._actCooldownTimer = setTimeout(function () {
      if (!self._pageAlive) return;
      const remain = Math.max(0, (self.data.diagActCooldownMs || 0) - 1000);
      self.setData({
        diagActCooldownMs: remain,
        diagActCooldownText: remain > 0
          ? `热风冷却中：约 ${Math.ceil(remain / 1000)} 秒后重试`
          : ''
      });
      if (remain > 0) self._runActCooldownCountdown();
    }, 1000);
  },

  stopActCooldown: function () {
    if (this._actCooldownTimer) {
      clearTimeout(this._actCooldownTimer);
      this._actCooldownTimer = null;
    }
  },

  // ========== 电机空载台架（开发测试区，仅诊断） ==========
  // 固件 motor_bench_self_test：开始台架只做门禁检查；严格在用户再次确认后
  // 才提交一次 5s 单方向测试。PWM 取板测参数滑杆/NVS，本页不直接操作 GPIO。

  selectMbType: function (e) {
    if (this.data.diagMbBusy) return;
    const t = e && e.currentTarget && e.currentTarget.dataset &&
      e.currentTarget.dataset.type;
    if (!t) return;
    this.setData({ diagMbType: t, diagMbPhase: 'idle', diagMbStatus: '' });
  },

  startMotorBench: function () {
    if (this.data.diagMbBusy) return;
    if (!this.data.bleConnected || !this.data.protocolReady) {
      wx.showToast({ title: '蓝牙未连接', icon: 'none' });
      return;
    }
    const info = MB_TYPE_INFO[this.data.diagMbType] || {};
    const behavior = this.data.diagMbType === 'pulsator_behavior';
    const self = this;
    wx.showModal({
      title: '电机空载台架',
      content: behavior
        ? `确认桶内无水、无衣物（空载）。将桶摆到 ${info.pos}。点「确认运行」后，ZS-X11B 将运行约 15s（正转 2s → PWM=0 滑停 → 反向 2s）。驱动没有刹车输入。`
        : `确认桶内无水、无衣物（空载）。将桶摆到 ${info.pos}（${info.desc || ''}）。点「确认运行」后，ZS-X11B 单方向运行一次 5 秒（含软启动斜坡）。`,
      confirmText: '开始',
      cancelText: '取消',
      success: function (res) {
        if (res.confirm) self.sendMotorBenchStart();
      }
    });
  },

  sendMotorBenchStart: function () {
    const type = this.data.diagMbType;
    this.stopMbPoll();
    this.setData({
      diagMbBusy: true,
      diagMbPhase: 'checking',
      diagMbStatus: '正在检查安全条件'
    });
    ble.sendProtocolCommand('motor_bench_start', { target: type },
      { timeoutMs: 5000, retries: 0 })
      .then(ack => {
        if (ack && ack.ok && ack.code === 'MOTOR_BENCH_ACCEPTED') {
          /* 重设 busy：受理前的陈旧 INACTIVE 快照可能在 syncMotorBench
           * 中被消费为「台架空闲」清掉 busy，这里恢复保证轮询启动。 */
          this.setData({
            diagMbBusy: true,
            diagMbPhase: 'checking',
            diagMbStatus: '已受理：请手动摆桶到指定位置'
          });
          this.pollMotorBench();
        } else {
          const code = ack && ack.code;
          this.setData({
            diagMbBusy: false,
            diagMbPhase: 'rejected',
            diagMbStatus: this.mapMbReject(code)
          });
        }
      })
      .catch(error => {
        const code = error && (error.code || error.errCode);
        this.setData({
          diagMbBusy: false,
          diagMbPhase: 'rejected',
          diagMbStatus: this.mapMbReject(code)
        });
      });
  },

  confirmMotorBenchPulse: function () {
    if (!this.data.diagMbBusy || this.data.diagMbPhase !== 'wait_confirm') return;
    if (!this.data.bleConnected || !this.data.protocolReady) {
      wx.showToast({ title: '蓝牙未连接', icon: 'none' });
      return;
    }
    const self = this;
    const behavior = this.data.diagMbType === 'pulsator_behavior';
    wx.showModal({
      title: behavior ? '确认波轮行为' : '确认脉冲',
      content: behavior
        ? `ZS-X11B 将运行约 15s：正转 2s → PWM=0 滑停 → 反向 2s → …。使用下方当前搅动 PWM 设置；确认桶内空载且已做好观察准备。`
        : `将向 ZS-X11B 提交一次 5 秒单方向测试（含软启动斜坡），使用下方当前搅动 PWM 设置。确认已对准位置并做好观察准备。`,
      confirmText: behavior ? '开始运行' : '确认运行',
      cancelText: '取消',
      success: function (res) {
        if (res.confirm) self.sendMotorBenchConfirm();
      }
    });
  },

  sendMotorBenchConfirm: function () {
    /* retries=2：确认幂等——固件仅消费一个 confirm_edge 离开 WAIT_CONFIRM，
     * 迟到的重复确认会得到 INTERNAL 拒绝而非二次脉冲，安全。写失败/ACK 丢失
     * 时自动重试，配合 ble.js 的写超时守卫，避免微信写通道瞬时故障丢确认。 */
    ble.sendProtocolCommand('motor_bench_confirm', {},
      { timeoutMs: 5000, retries: 2 })
      .then(ack => {
        if (ack && ack.ok) {
          this.setData({
            diagMbPhase: 'confirming',
            diagMbStatus: '已请求脉冲，等待固件提交…'
          });
        } else {
          this.setData({
            diagMbStatus: this.mapMbReject(ack && ack.code)
          });
        }
      })
      .catch(() => {
        this.setData({ diagMbStatus: '确认命令发送失败：请重试' });
      });
    /* 继续轮询：固件 FSM 会 PULSING → OFF_CONFIRM → COMPLETE / 下一步。 */
  },

  cancelMotorBench: function () {
    if (!this.data.diagMbBusy) return;
    const self = this;
    wx.showModal({
      title: '取消台架',
      content: '将请求固件把所有输出 OFF（电机/水/阀/泵/UV/热风），并结束本次台架。',
      confirmText: '取消台架',
      cancelText: '继续',
      success: function (res) {
        if (res.confirm) {
          ble.sendProtocolCommand('motor_bench_cancel', {},
            { timeoutMs: 5000, retries: 0 }).catch(() => {});
          /* 状态轮询会显示 INTERRUPTED 终端 + OFF 确认。 */
        }
      }
    });
  },

  /* 方向标定（开发/板级诊断）：置 direction_calibrated=true 并按 rpwm_is_cw
   * 记录 PWM 通道方向，写入 NVS。BL50 服务持实时配置指针，标定后下一命令
   * 立即生效（无需重启）。用户目视核对接线；方向不对可再次调用翻转。
   * 点击即发（不弹 showModal，规避该模态框在部分环境不显示的问题）：
   * 该命令只放行台架的脉冲能力，本身不产生任何电机运动（脉冲仍需台架
   * 开始的门禁 + 摆桶 + 二次确认，且单次测试固定 5s）。 */
  calibrateDirection: function () {
    if (!this.data.bleConnected) {
      wx.showToast({ title: '蓝牙未连接', icon: 'none' });
      return;
    }
    if (!this.data.diagMbCalSupported) {
      wx.showToast({ title: '固件不支持方向标定', icon: 'none' });
      return;
    }
    if (this.data.diagMbBusy) {
      wx.showToast({ title: '台架进行中：请先「取消台架」', icon: 'none' });
      return;
    }
    const self = this;
    self.setData({ diagMbCalStatus: '正在写入方向标定…' });
    wx.showToast({ title: '正在写入方向标定…', icon: 'loading' });
    /* bl50_reverse_dir=true：BL50 软件方向翻转（软件 CW=物理 CW），
     * 修正当前「软件 CW 命令→物理 CCW」的接线差异。 */
    ble.sendProtocolCommand('set_direction_calibration',
      { rpwm_is_cw: true, bl50_reverse_dir: true },
      { timeoutMs: 5000, retries: 2 })
      .then(ack => {
        if (ack && ack.ok && ack.code === 'DIRECTION_CALIBRATED') {
          self.setData({
            diagMbCalStatus: '方向已标定：IBT-2 ready + BL50 已翻转（CW=物理 CW）。可直接运行台架验证方向。'
          });
          wx.showToast({ title: '方向已标定', icon: 'success' });
        } else {
          const msg = self.mapMbReject(ack && ack.code);
          self.setData({ diagMbCalStatus: msg });
          wx.showToast({ title: '标定被拒', icon: 'none' });
        }
      })
      .catch(() => {
        self.setData({ diagMbCalStatus: '标定命令发送失败：请重试' });
        wx.showToast({ title: '发送失败，请重试', icon: 'none' });
      });
  },

  /* 换位电机（IBT-2 有刷位置电机）板测：驱动滚筒转到目标角度，霍尔确认。 */
  positionMoveTo: function (e) {
    if (!this.data.bleConnected || !this.data.diagPosEnabled) {
      wx.showToast({ title: '未连接或固件不支持', icon: 'none' });
      return;
    }
    const target = e && e.currentTarget && e.currentTarget.dataset.target;
    if (!target) return;
    const self = this;
    self.setData({ diagPosStatus: `正在驱动换位电机转到 ${target}°…` });
    ble.sendProtocolCommand('position_move_test', { target: target },
      { timeoutMs: 5000, retries: 2 })
      .then(ack => {
        if (ack && ack.ok && ack.code === 'POSITION_MOVE_ACCEPTED') {
          self.setData({ diagPosStatus: `已受理：换位电机转到 ${target}°，等待霍尔确认…` });
        } else {
          const code = ack && ack.code;
          self.setData({
            diagPosStatus: this.mapPosReject(code)
          });
        }
      })
      .catch(() => {
        self.setData({ diagPosStatus: '换位命令发送失败：请重试' });
      });
  },

  mapPosReject: function (code) {
    const map = {
      BAD_POSITION: '被拒绝：无效目标角度',
      EMERGENCY_ACTIVE: '被拒绝：设备处于急停状态',
      FAULT_ACTIVE: '被拒绝：设备存在故障',
      BL50_BUSY: '被拒绝：搅动电机(ZS-X11B)未空闲',
      POSITION_BUSY: '被拒绝：位置服务忙',
      POSITION_MOVE_REJECTED: '被拒绝：换位电机受理失败',
      SNAPSHOT_UNAVAILABLE: '被拒绝：安全快照不可用',
      BL50_UNAVAILABLE: '被拒绝：BL50 快照不可用',
      POSITION_UNAVAILABLE: '被拒绝：位置快照不可用',
      SWING_NOT_CALIBRATED: '被拒绝：未做方向标定，请先「方向标定」',
      SWING_BUSY: '被拒绝：连续换向已在运行',
      NOT_SUPPORTED: '被拒绝：固件不支持换位测试'
    };
    return map[code] || `被拒绝：${code || '未知原因'}`;
  },

  /* ---- 连续换向展示台（position_swing） ---- */

  startSwingTest: function () {
    if (!this.data.bleConnected || !this.data.diagSwingEnabled) {
      wx.showToast({ title: '未连接或固件不支持', icon: 'none' });
      return;
    }
    if (this.data.diagSwingBusy) {
      wx.showToast({ title: '换向进行中：请先停止', icon: 'none' });
      return;
    }
    if (this.data.diagMbBusy) {
      wx.showToast({ title: '台架运行中：请先取消台架', icon: 'none' });
      return;
    }
    const self = this;
    wx.showModal({
      title: '连续换向展示台',
      content: '将连续正转 → 刹停 → 反转 → 刹停… 共 4 段、每段 ~1.5s（固件 clamp：每段≤8s）。请确认桶内空载、设备前无人、已做好观察准备。',
      confirmText: '开始',
      success: (res) => {
        if (res.confirm) self.sendSwingStart();
      }
    });
  },

  sendSwingStart: function () {
    const self = this;
    this.setData({
      diagSwingBusy: true,
      diagSwingPhase: 'checking',
      diagSwingStatus: '正在检查安全条件…'
    });
    ble.sendProtocolCommand('position_swing_test', { rounds: 4, duration_ms: 1500 },
      { timeoutMs: 5000, retries: 0 })
      .then(ack => {
        if (ack && ack.ok && ack.code === 'POSITION_SWING_ACCEPTED') {
          self.setData({
            diagSwingPhase: 'running_cw',
            diagSwingStatus: '已受理：换向进行中（4 段 × ~1.5s），请观察…'
          });
          self.pollSwing();
        } else {
          const code = ack && ack.code;
          self.setData({
            diagSwingBusy: false,
            diagSwingPhase: 'rejected',
            diagSwingStatus: self.mapSwingReject(code)
          });
        }
      })
      .catch((err) => {
        self.setData({
          diagSwingBusy: false,
          diagSwingPhase: 'rejected',
          diagSwingStatus: self.mapSwingSendError(err)
        });
      });
  },

  /* 发送级失败可能与「固件还不认识新命令」混淆，区分：
   *  - 已收到过 capabilities 且含 position_swing_test → 固件支持但 A/B 写失败
   *    （可重试 / 断线则先恢复连接）；
   *  - 从未收到 capabilities → 固件可能是旧版本，明确提示需重烧固件。 */
  mapSwingSendError: function (err) {
    const code = err && (err.code || err.errCode || err.message);
    let hint = '蓝牙未连接或发送失败';
    if (code === 'BLE_NOT_CONNECTED' || code === 'BLE_DISCONNECTED') {
      hint = '蓝牙未连接/已断开：请先连接设备';
    } else if (!this.data.diagCapSeen) {
      hint = '固件未回 capabilities（旧版本？）— 请重烧含 position_swing_test 的固件后重连';
    }
    return '换向命令发送失败：' + hint;
  },

  cancelSwingTest: function () {
    if (!this.data.diagSwingBusy) return;
    const self = this;
    wx.showModal({
      title: '停止连续换向',
      content: '将请求固件把 IBT-2 立即 OFF，并结束本次展示台。',
      confirmText: '停止',
      success: (res) => {
        if (!res.confirm) return;
        self.sendSwingCancel();
      }
    });
  },

  sendSwingCancel: function () {
    const self = this;
    ble.sendProtocolCommand('position_swing_cancel', {},
      { timeoutMs: 5000, retries: 0 })
      .then(ack => {
        if (ack && ack.ok) {
          self.setData({
            diagSwingBusy: false,
            diagSwingPhase: 'interrupted',
            diagSwingStatus: '已停止：IBT-2 已关（等待状态确认）'
          });
        } else {
          const code = ack && ack.code;
          self.setData({
            diagSwingStatus: self.mapSwingReject(code)
          });
          self.pollSwing();
        }
      })
      .catch(() => {
        self.setData({ diagSwingStatus: '停止命令发送失败，请点击「刷新状态」' });
        self.pollSwing();
      });
  },

  resyncSwingStatus: function () {
    this.pollSwing(true);
  },

  pollSwing: function (force) {
    const self = this;
    this.stopSwingPoll();
    if (force) {
      ble.sendProtocolCommand('get_status', {}, { retries: 0 })
        .catch(() => {})
        .then(() => this.readSwingSnapshot());
      return;
    }
    this._swingPollCount = 0;
    const tick = () => {
      if (!this._pageAlive) return;
      ble.sendProtocolCommand('get_status', {}, { retries: 0 })
        .catch(() => {})
        .then(() => {
          if (!this._pageAlive) return;
          self.readSwingSnapshot();
          if (self.data.diagSwingBusy) {
            self._swingPollCount = (self._swingPollCount || 0) + 1;
            if (self._swingPollCount > 300) {
              self.setData({
                diagSwingBusy: false,
                diagSwingPhase: 'unknown',
                diagSwingStatus: '换向状态未知：请查看串口日志'
              });
              return;
            }
            self._swingPollTimer = setTimeout(tick, 1000);
          }
        });
    };
    self._swingPollTimer = setTimeout(tick, 500);
  },

  readSwingSnapshot: function () {
    const snap = ble.getProtocolSnapshot();
    const status = snap && snap.status;
    const s = status && status.position_swing;
    if (!s) {
      /* 固件状态无 swing 子块时：若本地 busy 且无终态则保持未知 */
      if (this.data.diagSwingBusy && this.data.diagSwingPhase !== 'idle') {
        this.setData({
          diagSwingBusy: false,
          diagSwingPhase: 'unknown',
          diagSwingStatus: '换向状态不可读：固件未上报 position_swing'
        });
      }
      return;
    }
    this.syncSwing(s);
  },

  stopSwingPoll: function () {
    if (this._swingPollTimer) {
      clearTimeout(this._swingPollTimer);
      this._swingPollTimer = null;
    }
    this._swingPollCount = 0;
  },

  syncSwing: function (s) {
    const st = Number(s.st);
    const term = Number(s.term) || 0;
    const seg = Number(s.seg) || 0;
    const dir = Number(s.dir) === 1;
    const off = Number(s.off) === 1;
    const rounds = Number(s.rounds) || 4;
    const dwell = Number(s.dwell) || 1500;
    const emerg = Number(s.emerg) === 1;

    const SWING_STATE = {
      INACTIVE: 0, PRECHECK: 1, RUNNING_CW: 2, BRAKING: 3,
      RUNNING_CCW: 4, FAULT: 5, COMPLETE: 6, REJECTED: 7,
      INTERRUPTED: 8, TIMEOUT: 9
    };

    let busy = this.data.diagSwingBusy;
    let phase = this.data.diagSwingPhase;
    let status = this.data.diagSwingStatus;

    if (term !== 0) {
      busy = false;
      const map = {
        1: '已完成（输出已确认关闭）',
        2: '被拒绝',
        3: '已中断（紧急/停止）',
        4: '超时',
        5: '故障'
      };
      phase = term === 1 ? 'complete' :
              term === 2 ? 'rejected' :
              term === 3 ? 'interrupted' :
              term === 4 ? 'timeout' : 'fault';
      status = map[term] || ('终态码 ' + term);
      if (phase === 'interrupted') {
        status = off ? '已停止，输出已确认关闭' : '已停止（输出未确认关闭，请检查）';
      }
    } else if (st === SWING_STATE.PRECHECK || st === SWING_STATE.RUNNING_CW ||
               st === SWING_STATE.RUNNING_CCW || st === SWING_STATE.BRAKING) {
      busy = true;
      status = emerg
        ? '紧急状态：请停止/断电检查'
        : (st === 1 ? '正在检查安全条件…'
           : (st === 3 ? `刹车中（段 ${seg + 1}/${rounds}）`
             : `换向运行中：段 ${seg + 1}/${rounds} · ${dir ? 'CW' : 'CCW'}`));
      phase = st === 1 ? 'checking' :
              st === 3 ? 'braking' :
              (dir ? 'running_cw' : 'running_ccw');
    } else if (st === SWING_STATE.FAULT) {
      busy = false;
      phase = 'fault';
      status = off ? '换向故障（已确认关闭），请查看串口日志' : '换向故障（输出未确认关闭），请立即断电检查';
    } else if (st === SWING_STATE.INACTIVE) {
      if (busy) {
        busy = false;
        phase = 'idle';
        status = '换向已空闲';
      }
    }

    this.setData({
      diagSwingBusy: busy,
      diagSwingPhase: phase,
      diagSwingStatus: status,
      diagSwingSegDone: seg,
      diagSwingDirCw: dir,
      diagSwingOff: off,
      diagSwingRounds: rounds,
      diagSwingDwellMs: dwell,
      diagSwingTerm: term
    });

    if (term !== 0 || st === SWING_STATE.COMPLETE) {
      this.stopSwingPoll();
    }
  },

  mapSwingReject: function (code) {
    const map = {
      SWING_NOT_CALIBRATED: '被拒绝：未做方向标定，请先「方向标定」',
      SWING_BUSY: '被拒绝：换向已在运行',
      BUSY: '被拒绝：设备忙（可能已有程序/自检运行）',
      EXECUTOR_BUSY: '被拒绝：设备洗涤程序未空闲',
      SELF_TEST_BUSY: '被拒绝：已有自检/台架进行中',
      FAULT_ACTIVE: '被拒绝：设备存在故障',
      EMERGENCY_ACTIVE: '被拒绝：设备处于急停状态',
      HALL_CONFLICT: '被拒绝：多霍尔矛盾',
      GATE_UNAVAILABLE: '被拒绝：安全快照不可用',
      NOT_SUPPORTED: '被拒绝：固件不支持换向展示台'
    };
    return map[code] || `被拒绝：${code || '未知原因'}`;
  },

  markSwingStatusUnknown: function () {
    this.stopSwingPoll();
    if (this.data.diagSwingBusy || this.data.diagSwingPhase !== 'idle') {
      this.setData({
        diagSwingBusy: false,
        diagSwingPhase: 'unknown',
        diagSwingStatus: '已请求全部输出关闭，状态待设备确认'
      });
    }
  },

  /* BLE 断线立刻把 swing 状态打回 idle。固件断线服务关断言 + 服务端会
   * INTERRUPTED 终态；重连后由 status.position_swing 快照覆盖（pollSwing）。 */
  resetSwingOnDisconnect: function () {
    this.stopSwingPoll();
    this.setData({
      diagSwingBusy: false,
      diagSwingPhase: 'idle',
      diagSwingStatus: ''
    });
  },

  pollMotorBench: function () {
    this.stopMbPoll();
    this._mbPollCount = 0;
    const tick = () => {
      if (!this._pageAlive) return;
      ble.sendProtocolCommand('get_status', {}, { retries: 0 })
        .catch(() => {})
        .then(() => {
          if (!this._pageAlive) return;
          try {
            /* status 推送已由 onDataReceived → syncMotorBench 消费；此处兜底读快照。 */
            const snap = ble.getProtocolSnapshot();
            const status = snap && snap.status;
            const mb = status && status.motor_bench;
            if (mb) this.syncMotorBench(mb);
          } catch (e) {
            /* 任何同步异常都不能杀死轮询：记录并继续，否则卡死在最后状态。 */
            console.warn('[MB] poll sync error:', e);
          }
          if (this.data.diagMbBusy) {
            this._mbPollCount = (this._mbPollCount || 0) + 1;
            /* 固件每步位置等待超时 120s；轮询上限 ~300s 兜底（终态会先触发停止）。 */
            if (this._mbPollCount > 300) {
              this.setData({
                diagMbBusy: false,
                diagMbPhase: 'unknown',
                diagMbStatus: '台架状态未知：请查看串口日志'
              });
              return;
            }
            this._mbPollTimer = setTimeout(tick, 1000);
          }
        });
    };
    this._mbPollTimer = setTimeout(tick, 500);
  },

  stopMbPoll: function () {
    if (this._mbPollTimer) {
      clearTimeout(this._mbPollTimer);
      this._mbPollTimer = null;
    }
    this._mbPollCount = 0;
  },

  markMbStatusUnknown: function () {
    /* BLE 断开：固件仅收到 emergency 全 OFF 请求，未确认输出状态。
     * 文案只能承诺「已请求关闭，待设备确认」，不得声称已执行。 */
    this.stopMbPoll();
    if (this.data.diagMbBusy || this.data.diagMbPhase !== 'idle') {
      this.setData({
        diagMbPhase: 'unknown',
        diagMbBusy: false,
        diagMbStatus: '已请求全部输出关闭，状态待设备确认'
      });
    }
  },

  /* status 快照 → 台架展示（st/pos/ready/step/steps/term/off）。 */
  syncMotorBench: function (mb) {
    const st = Number(mb.st);
    const term = Number(mb.term);
    const ready = Number(mb.ready) === 1;
    const off = Number(mb.off) === 1;
    const step = Number(mb.step) || 0;
    const steps = Number(mb.steps) || 0;
    const pos = Number(mb.pos) || 0;
    const lc = (mb && mb.lc) || '';   /* 固件 last_code：ACCEPTED/拒绝码/等待原因/终态码 */
    const behavior = this.data.diagMbType === 'pulsator_behavior';

    /* 无台架活动且本页也未启动过：保持 idle，不覆盖其他展示。 */
    if (!this.data.diagMbBusy && st === MB_STATE.INACTIVE &&
        term === MB_TERMINAL.NONE) {
      return;
    }

    let busy = this.data.diagMbBusy;
    let phase = this.data.diagMbPhase;
    let status = this.data.diagMbStatus;

    switch (st) {
      case MB_STATE.INACTIVE:
        busy = false; phase = 'idle';
        status = this.data.diagMbPhase === 'idle' ? '' : '台架空闲';
        break;
      case MB_STATE.PRECHECK:
        phase = 'checking'; status = '正在检查安全条件';
        break;
      case MB_STATE.WAIT_POSITION:
        busy = true; phase = 'wait_pos';
        status = ready
          ? `位置已就位：请点击「确认运行」（${pos}°）`
          : `等待手动摆桶到 ${pos}°（步 ${step + 1}/${steps}）` +
            (lc && !lc.startsWith('WAIT_POSITION') && !lc.startsWith('PRECHECK')
              ? ` · ${lc}` : '');
        break;
      case MB_STATE.WAIT_CONFIRM:
        busy = true; phase = 'wait_confirm';
        status = behavior
          ? `位置 ${pos}° 已就位，点击「确认运行」提交正反交替测试`
          : `位置 ${pos}° 已就位，点击「确认运行」提交一次单方向5秒测试`;
        break;
      case MB_STATE.PULSING:
        busy = true; phase = 'pulsing';
        status = behavior
          ? '正反交替测试运行中（约15秒）…'
          : '单方向测试运行中（约5秒）…';
        break;
      case MB_STATE.OFF_CONFIRM:
        busy = true; phase = 'off_confirm';
        status = '确认电机已关闭…';
        break;
      case MB_STATE.COMPLETE:
        busy = false; phase = 'complete';
        status = `完成：全部 ${steps} 步通过` +
          (off ? '，输出已确认关闭' : '，输出未确认关闭');
        break;
      case MB_STATE.REJECTED:
        busy = false; phase = 'rejected';
        status = `被拒绝：${this.mapMbTerm(term, off)}` +
          (lc && lc !== 'REJECTED' ? ` · ${lc}` : '');
        break;
      case MB_STATE.INTERRUPTED:
        busy = false; phase = 'interrupted';
        status = '被中断（取消/紧急/断线）：' +
          (off ? '输出已确认关闭' : '输出未确认关闭，请检查') +
          (lc ? ` · ${lc}` : '');
        break;
      case MB_STATE.TIMEOUT:
        busy = false; phase = 'timeout';
        status = '超时：' + (lc || '等待超时') + '，' +
          (off ? '输出已确认关闭' : '输出未确认关闭，请检查');
        break;
      case MB_STATE.FAULT:
        busy = false; phase = 'fault';
        status = off
          ? `台架故障：${lc || '未知'}，输出已确认关闭，请查看串口日志`
          : `台架故障（输出未确认关闭）：${lc || '未知'}，请立即断电检查`;
        break;
      default:
        phase = 'unknown';
        status = '台架状态未知';
    }

    this.setData({
      diagMbBusy: busy,
      diagMbPhase: phase,
      diagMbStatus: status,
      diagMbPos: pos,
      diagMbStep: step,
      diagMbSteps: steps,
      diagMbReady: ready,
      diagMbTerm: term,
      diagMbOff: off,
      diagMbLc: lc
    });

    /* 到达终态：停止轮询，保留结果展示。 */
    if (term !== MB_TERMINAL.NONE || st === MB_STATE.COMPLETE) {
      this.stopMbPoll();
    }
  },

  mapMbReject: function (code) {
    const map = {
      EXECUTOR_BUSY: '被拒绝：设备不在空闲状态（洗涤运行中）',
      SELF_TEST_BUSY: '被拒绝：已有自检/台架进行中',
      FAULT_ACTIVE: '被拒绝：设备存在故障',
      EMERGENCY_ACTIVE: '被拒绝：设备处于急停状态',
      POSITION_UNKNOWN: '被拒绝：位置状态无效',
      POSITION_STALE: '被拒绝：位置状态已过期',
      POSITION_UNSTABLE: '被拒绝：位置不稳定',
      MOTOR_MOVING: '被拒绝：电机正在运动',
      MOTOR_POSITION_MISMATCH: '被拒绝：桶位置与目标角度不一致',
      HALL_CONFLICT: '被拒绝：多霍尔矛盾（请检查霍尔传感器）',
      OUTPUT_STATE_UNKNOWN: '被拒绝：输出状态未知',
      FORBIDDEN_OUTPUT_ON: '被拒绝：禁止的输出仍开启',
      POSITION_SERVICE_BUSY: '被拒绝：位置服务忙',
      SERVICE_BUSY: '被拒绝：水/洗涤剂/排水等服务忙',
      REQUEST_ID_INVALID: '被拒绝：请求号无效',
      MOTOR_BENCH_SNAPSHOT_UNAVAILABLE: '被拒绝：安全快照不可用',
      BAD_TYPE: '被拒绝：未知台架类型',
      UNKNOWN_TARGET: '被拒绝：未知台架类型',
      NOT_SUPPORTED: '被拒绝：固件不支持台架',
      INTERNAL: '内部错误（可能位置未就位）'
    };
    return map[code] || `被拒绝：${code || '未知原因'}`;
  },

  mapMbTerm: function (term, off) {
    switch (Number(term)) {
      case MB_TERMINAL.COMPLETE: return '已完成';
      case MB_TERMINAL.REJECTED: return '安全条件不满足';
      case MB_TERMINAL.INTERRUPTED: return '已取消/紧急';
      case MB_TERMINAL.TIMEOUT: return '位置等待超时';
      case MB_TERMINAL.FAULT: return '故障';
      default: return '未知原因';
    }
  },

  // ========== 自动负向测试（仅诊断，生产开关关闭时不渲染） ==========

  actStateLabel: function (st) {
    const map = {
      0: '空闲', 1: '检查中', 2: '已受理', 3: '运行中', 4: '完成',
      5: '被拒绝', 6: '被中断', 7: '超时', 8: '故障', 9: '未知'
    };
    return map[Number(st)] || '未知';
  },

  // ---- A. 阀互锁自动测试：source 受理后 200ms 请求 transfer 必须被拒绝 ----

  runInterlockAutoTest: function () {
    if (this.data.diagIlkBusy || this.data.diagBleBusy) return; /* 防重复点击/互斥 */
    if (!this.data.bleConnected || !this.data.protocolReady) {
      wx.showToast({ title: '蓝牙未连接', icon: 'none' });
      return;
    }
    const self = this;
    wx.showModal({
      title: '阀互锁自动测试',
      content: '高风险确认：将开启有压进水阀约 1.5 秒，随后请求零压转移阀必须被设备拒绝。请确认水路已接入容器。',
      confirmText: '确认执行',
      cancelText: '取消',
      success: function (res) {
        if (!res.confirm) return;
        wx.showModal({
          title: '二次确认',
          content: '再次确认：测试期间请勿触碰水路。设备会自动关闭所有输出。',
          confirmText: '确认执行',
          cancelText: '取消',
          success: function (res2) {
            if (res2.confirm) self.startInterlockTest();
          }
        });
      }
    });
  },

  startInterlockTest: function () {
    this.stopActPoll();
    this.stopIlkPoll();
    this.setData({
      diagIlkBusy: true,
      diagIlkPhase: 'req_source',
      diagIlkStatus: '正在请求有压进水阀自检…',
      diagIlkSourceAck: '',
      diagIlkTransferAck: '',
      diagIlkTerminal: '',
      diagIlkOff: false,
      diagIlkResult: ''
    });
    this.sendInterlockSource();
  },

  sendInterlockSource: function () {
    const self = this;
    ble.sendProtocolCommand('actuator_self_test', { target: 'source_valve' },
      { timeoutMs: 5000, retries: 0 })
      .then(ack => {
        const ok = !!(ack && ack.ok && ack.code === 'ACTUATOR_SELF_TEST_ACCEPTED');
        if (!ok) {
          self.setData({
            diagIlkSourceAck: (ack && ack.code) || 'NO_ACK',
            diagIlkPhase: 'fail',
            diagIlkResult: 'FAIL',
            diagIlkStatus: '进水阀请求未被受理，互锁测试前提不成立',
            diagIlkBusy: false
          });
          return;
        }
        self.setData({
          diagIlkSourceAck: 'ACCEPTED',
          diagIlkPhase: 'source_accepted',
          diagIlkStatus: '进水阀已受理；200ms 后请求转移阀…'
        });
        self._ilkTransferTimer = setTimeout(() => self.sendInterlockTransfer(), 200);
      })
      .catch(error => {
        const code = error && (error.code || error.errCode);
        self.setData({
          diagIlkSourceAck: code || 'ERR',
          diagIlkPhase: 'fail',
          diagIlkResult: 'FAIL',
          diagIlkStatus: `进水阀请求失败：${code || '未知'}，测试中止`,
          diagIlkBusy: false
        });
      });
  },

  sendInterlockTransfer: function () {
    const self = this;
    ble.sendProtocolCommand('actuator_self_test', { target: 'transfer_valve' },
      { timeoutMs: 5000, retries: 0 })
      .then(ack => {
        /* 设备侧若受理则互锁失效 → FAIL；正常应走 reject。 */
        self.setData({
          diagIlkTransferAck: (ack && ack.code) || 'ACCEPTED',
          diagIlkPhase: 'fail',
          diagIlkResult: 'FAIL',
          diagIlkStatus: '错误：第二个请求被受理（互锁失效）',
          diagIlkBusy: false
        });
      })
      .catch(error => {
        const code = error && (error.code || error.errCode);
        self.setData({
          diagIlkTransferAck: code || 'NACK',
          diagIlkPhase: 'transfer_done',
          diagIlkStatus: `转移阀请求被拒绝（${code || 'NACK'}），符合互锁预期；等待首个自检终态…`
        });
        self.pollInterlockTerminal();
      });
  },

  pollInterlockTerminal: function () {
    this.stopIlkPoll();
    this._ilkPollCount = 0;
    const tick = () => {
      if (!this._pageAlive) return;
      /* 主动 get_status 刷新缓存（固件不在自检后自动推送 status）。 */
      ble.sendProtocolCommand('get_status', {}, { retries: 0 })
        .catch(() => {})
        .then(() => {
          if (!this._pageAlive) return;
          const snap = ble.getProtocolSnapshot();
          const status = snap && snap.status;
          const act = status && status.actuator_self_test;
          if (!act) {
            this._ilkPollCount++;
            if (this._ilkPollCount > 60) {
              this.setData({
                diagIlkPhase: 'fail', diagIlkResult: 'FAIL',
                diagIlkStatus: '等待自检终态超时，测试失败'
              });
              return;
            }
            this._ilkPollTimer = setTimeout(tick, 500);
            return;
          }
          const st = Number(act.st);
          if (st === ACT_SELF_TEST_STATUS.RUNNING ||
              st === ACT_SELF_TEST_STATUS.ACCEPTED ||
              st === ACT_SELF_TEST_STATUS.CHECKING) {
            this._ilkPollTimer = setTimeout(tick, 500);
            return;
          }
          const off = Number(act.off) === 1;
          const stName = this.actStateLabel(st);
          if (st === ACT_SELF_TEST_STATUS.COMPLETE && off) {
            this.setData({
              diagIlkTerminal: stName, diagIlkOff: off,
              diagIlkPhase: 'done', diagIlkResult: 'PASS',
              diagIlkStatus: '互锁测试通过：首个自检完成且输出已确认关闭；两次请求未同时受理'
            });
          } else if (st === ACT_SELF_TEST_STATUS.COMPLETE && !off) {
            this.setData({
              diagIlkTerminal: stName, diagIlkOff: false,
              diagIlkPhase: 'fail', diagIlkResult: 'FAIL',
              diagIlkStatus: '互锁测试失败：自检完成但输出未确认关闭'
            });
          } else {
            this.setData({
              diagIlkTerminal: stName, diagIlkOff: off,
              diagIlkPhase: 'fail', diagIlkResult: 'FAIL',
              diagIlkStatus: `互锁测试失败：终态 ${stName}，off=${off}`
            });
          }
          this.setData({ diagIlkBusy: false });
        });
    };
    tick();
  },

  stopIlkPoll: function () {
    if (this._ilkPollTimer) {
      clearTimeout(this._ilkPollTimer);
      this._ilkPollTimer = null;
    }
    this._ilkPollCount = 0;
    if (this._ilkTransferTimer) {
      clearTimeout(this._ilkTransferTimer);
      this._ilkTransferTimer = null;
    }
  },

  // ---- B. BLE 断线自动关断测试：source 受理后 250ms 断开，重连后查终态 ----

  runBleDisconnectAutoTest: function () {
    if (this.data.diagBleBusy || this.data.diagIlkBusy) return; /* 防重复点击/互斥 */
    if (!this.data.bleConnected || !this.data.protocolReady) {
      wx.showToast({ title: '蓝牙未连接', icon: 'none' });
      return;
    }
    const self = this;
    wx.showModal({
      title: 'BLE 断线自动关断测试',
      content: '高风险确认：将开启有压进水阀约 1.5 秒，250ms 后主动断开蓝牙，验证设备自动关断。',
      confirmText: '确认执行',
      cancelText: '取消',
      success: function (res) {
        if (!res.confirm) return;
        wx.showModal({
          title: '二次确认',
          content: '再次确认：设备会自动重连并查询关断状态。测试期间请勿触碰水路。',
          confirmText: '确认执行',
          cancelText: '取消',
          success: function (res2) {
            if (res2.confirm) self.startBleDisconnectTest();
          }
        });
      }
    });
  },

  startBleDisconnectTest: function () {
    this.stopActPoll();
    this.stopBleDiscPoll();
    this.setData({
      diagBleBusy: true,
      diagBlePhase: 'req_source',
      diagBleStatus: '正在请求有压进水阀自检…',
      diagBleTerminal: '',
      diagBleLastCode: '',
      diagBleOff: false,
      diagBleResult: ''
    });
    this.sendBleDisconnectSource();
  },

  sendBleDisconnectSource: function () {
    const self = this;
    ble.sendProtocolCommand('actuator_self_test', { target: 'source_valve' },
      { timeoutMs: 5000, retries: 0 })
      .then(ack => {
        const ok = !!(ack && ack.ok && ack.code === 'ACTUATOR_SELF_TEST_ACCEPTED');
        if (!ok) {
          self.setData({
            diagBlePhase: 'fail', diagBleResult: 'FAIL',
            diagBleStatus: '进水阀请求未被受理，测试中止',
            diagBleBusy: false
          });
          return;
        }
        self.setData({
          diagBlePhase: 'source_accepted',
          diagBleStatus: '进水阀已受理；250ms 后断开蓝牙…'
        });
        self._bleDiscTimer = setTimeout(() => self.doBleDisconnect(), 250);
      })
      .catch(error => {
        const code = error && (error.code || error.errCode);
        self.setData({
          diagBlePhase: 'fail', diagBleResult: 'FAIL',
          diagBleStatus: `进水阀请求失败：${code || '未知'}，测试中止`,
          diagBleBusy: false
        });
      });
  },

  doBleDisconnect: function () {
    /* 断线后必须显示"已请求断线关断，等待设备重新连接确认"，
       不得在设备证据前显示"已安全关闭"。 */
    this.setData({
      diagBlePhase: 'disconnect',
      diagBleStatus: '已请求断线关断，等待设备重新连接确认'
    });
    if (typeof ble.disconnectForDiagnostic === 'function') {
      ble.disconnectForDiagnostic();
    } else if (this.data.bleDeviceId) {
      wx.closeBLEConnection({ deviceId: this.data.bleDeviceId });
    }
    this.pollBleDisconnect();
  },

  pollBleDisconnect: function () {
    this.stopBleDiscPoll();
    this._blePollCount = 0;
    const tick = () => {
      if (!this._pageAlive) return;
      const snap = ble.getProtocolSnapshot();
      const connected = snap && snap.connected && snap.protocolReady;
      const status = snap && snap.status;
      const act = status && status.actuator_self_test;
      if (!connected) {
        this.setData({
          diagBlePhase: 'disconnect',
          diagBleStatus: '已请求断线关断，等待设备重新连接确认'
        });
        this._blePollCount++;
        if (this._blePollCount > 120) {
          this.setData({
            diagBlePhase: 'fail', diagBleResult: 'FAIL',
            diagBleStatus: '等待设备重新连接超时，测试失败'
          });
          return;
        }
        this._blePollTimer = setTimeout(tick, 500);
        return;
      }
      if (!act) {
        this._blePollCount++;
        if (this._blePollCount > 40) {
          this.setData({
            diagBlePhase: 'fail', diagBleResult: 'FAIL',
            diagBleStatus: '重连后未取到板测状态，测试失败'
          });
          return;
        }
        this._blePollTimer = setTimeout(tick, 500);
        return;
      }
      const st = Number(act.st);
      const off = Number(act.off) === 1;
      const stName = this.actStateLabel(st);
      const lastCode = act.last_code || act.code || '';
      if (st === ACT_SELF_TEST_STATUS.RUNNING ||
          st === ACT_SELF_TEST_STATUS.ACCEPTED ||
          st === ACT_SELF_TEST_STATUS.CHECKING) {
        this.setData({
          diagBlePhase: 'disconnect',
          diagBleStatus: '设备已重连，等待关断终态确认…'
        });
        this._blePollCount = 0;
        this._blePollTimer = setTimeout(tick, 500);
        return;
      }
      const interrupted = st === ACT_SELF_TEST_STATUS.INTERRUPTED;
      this.setData({
        diagBlePhase: 'done',
        diagBleTerminal: stName,
        diagBleLastCode: lastCode,
        diagBleOff: off
      });
      if (off) {
        this.setData({
          diagBleResult: interrupted ? 'PASS' : 'INFO',
          diagBleStatus: `已确认关闭：终态 ${stName}，输出已确认关闭`,
          diagBleBusy: false
        });
      } else {
        this.setData({
          diagBleResult: 'FAIL',
          diagBleStatus: `输出未确认关闭：终态 ${stName}，off=false`,
          diagBleBusy: false
        });
      }
    };
    tick();
  },

  stopBleDiscPoll: function () {
    if (this._blePollTimer) {
      clearTimeout(this._blePollTimer);
      this._blePollTimer = null;
    }
    this._blePollCount = 0;
    if (this._bleDiscTimer) {
      clearTimeout(this._bleDiscTimer);
      this._bleDiscTimer = null;
    }
  },

  toggleBooking: function (e) {
    this.setData({ isBooking: e.detail.value });
    if (e.detail.value) {
      this.calculateEndTime();
    }
  },

  onDateChange: function (e) {
    this.setData({ bookingDate: e.detail.value });
    this.calculateEndTime();
  },

  onTimeChange: function (e) {
    this.setData({ bookingTime: e.detail.value });
    this.calculateEndTime();
  },

  calculateEndTime: function () {
    const { bookingDate, bookingTime, totalTime } = this.data;

    if (!bookingDate || !bookingTime) {
      this.setData({ endTimePreview: '--:--' });
      return;
    }

    const startDateTime = new Date(`${bookingDate}T${bookingTime}:00`);
    const endDateTime = new Date(startDateTime.getTime() + totalTime * 60 * 1000);

    const endDateStr = this.formatDate(endDateTime);
    const endTimeStr = this.formatTime(endDateTime);

    this.setData({
      endTimePreview: `${endDateStr} ${endTimeStr}`
    });
  },

  createBooking: function (orderData) {
    wx.showModal({
      title: '确认预约',
      content: `设备：${orderData.deviceName}\n预约时间：${orderData.startTime}\n预计完成：${orderData.endTime}\n时长：${orderData.totalTime}分钟\n金额：¥${orderData.finalPrice}${orderData.couponId ? '\n已使用优惠券抵扣' : ''}`,
      confirmText: '确认预约',
      success: (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '创建预约...' });

          wx.cloud.callFunction({
            name: 'createOrderV2',
            data: {
              ...orderData,
              isBooking: true
            }
          }).then(res => {
            wx.hideLoading();

            // 刷新优惠券列表
            this.loadCoupons();

            wx.showModal({
              title: '预约成功',
              content: `预约时间：${orderData.startTime}\n预计完成：${orderData.endTime}\n\n到时间后请打开预约页，连接设备并点击“立即启动”。`,
              showCancel: false,
              confirmText: '知道了',
              success: () => {
                wx.switchTab({ url: '/pages/booking/booking' });
              }
            });
          }).catch(err => {
            wx.hideLoading();
            console.error('预约失败:', err);
            wx.showToast({ title: '预约失败，请重试', icon: 'none' });
          });
        }
      }
    });
  },

  // ========== 蓝牙启动清洗 ==========
  sendStartWithBusyRecovery: function (orderData) {
    const sendStart = () => ble.sendProtocolCommand(
      'start_formal',
      ble.buildFormalPayload(orderData),
      { timeoutMs: 5000, retries: 2 }
    );

    return sendStart().catch(error => {
      if (!error || error.code !== 'BUSY') throw error;

      wx.showLoading({ title: '正在核对设备状态...' });
      return ble.sendProtocolCommand(
        'get_status',
        {},
        { timeoutMs: 2500, retries: 1 }
      ).then(() => new Promise(resolve => setTimeout(resolve, 180)))
        .then(() => {
          const snapshot = ble.getProtocolSnapshot();
          const status = snapshot && snapshot.status;
          const state = Number(status && status.state);
          const programId = Number(status && status.program_id) || 0;

          // The first start may have been accepted while its ACK was lost.
          // WAIT_LOAD is the deterministic first externally visible state.
          if (state === 2 && programId > 0) {
            return {
              type: 'ack',
              ok: true,
              code: 'RECOVERED_ALREADY_STARTED',
              program_id: programId,
              recovered: true
            };
          }

          // IDLE + BUSY is the executor terminal-release window. Retry the
          // same cloud order exactly once after that reservation can clear.
          if (state === 1) {
            return new Promise(resolve => setTimeout(resolve, 250))
              .then(sendStart);
          }

          const busy = new Error('设备已有未完成程序');
          busy.code = 'BUSY';
          busy.machineState = Number.isFinite(state) ? state : -1;
          busy.programId = programId;
          throw busy;
        })
        .catch(statusError => {
          if (statusError && statusError.machineState !== undefined) {
            throw statusError;
          }
          throw error;
        });
    });
  },

  startWashViaBLE: function (orderData) {
    wx.showLoading({ title: '正在准备启动...' });

    // 先保存订单到云端
    this.ensureBleReadyForCommand(orderData)
      .then(() => {
        wx.showLoading({ title: '正在创建订单...' });
        if (this.data._sourceBookingId) {
          return {
            code: 0,
            data: {
              orderId: this.data._sourceBookingId,
              reused: true
            }
          };
        }
        return this.saveOrder(orderData);
      })
      .then((result) => {
        if (!result || result.code !== 0) {
          wx.hideLoading();
          this.setData({ commandBusy: false });
          wx.showToast({ title: '订单创建失败', icon: 'none' });
          return;
        }

        const orderId = result.data ? result.data.orderId : '';
        wx.showLoading({ title: '等待设备确认...' });
        this.setData({ commandBusy: true });

        return this.sendStartWithBusyRecovery(orderData).then((ack) => {
          wx.hideLoading();

          this.setData({
            isWashing: true,
            commandBusy: false,
            awaitingLoad: true,
            statusText: '等待放入衣物',
            activeProgramId: Number(ack.program_id) || 0,
            _currentOrderId: orderId,
            progress: 0,
            remainingTime: orderData.totalTime,
            useRealProgress: true
          });
          this.updateOrderRuntimeStatus(orderId, '进行中', {
            programId: Number(ack.program_id) || 0
          }).catch(() => {});
          this.loadCoupons();

          wx.showModal({
            title: '程序已受理',
            content: '请放入衣物并关好舱门，然后点击“已放入衣物，开始清洗”。',
            showCancel: false,
            confirmText: '知道了'
          });
          this.refreshDeviceStatus();
        }).catch((err) => {
          console.error('ESP32拒绝或未确认启动:', err);
          wx.hideLoading();
          this.setData({ commandBusy: false });
          const uncertain = err && (
            err.code === 'ACK_TIMEOUT' ||
            err.code === 'BLE_DISCONNECTED' ||
            err.errCode === 10006
          );
          this.updateOrderRuntimeStatus(
            orderId,
            uncertain ? '启动待确认' : '启动失败',
            { errorCode: err && (err.code || err.errCode || err.message) }
          ).catch(() => {});
          const busyState = Number(err && err.machineState);
          const busyMessage = busyState === 4
            ? '上一程序正在等待取出衣物，请先完成取衣确认。'
            : (busyState >= 2 && busyState <= 7
                ? '设备已有洗涤程序运行，请先完成或停止当前程序。'
                : `ESP32 未确认命令：${err.code || err.message || '未知错误'}。订单已创建，但设备没有被标记为运行。`);
          wx.showModal({
            title: '设备未启动',
            content: busyMessage,
            showCancel: false
          });
        });
      })
      .catch((err) => {
        wx.hideLoading();
        this.setData({ commandBusy: false, _startNow: false });
        const debug = ble.getLastConnectDebug();
        const code = err && (err.code || err.errCode || err.errno || err.message);
        const debugId = debug && debug.deviceId ? debug.deviceId : '-';
        console.error('连接/订单准备失败:', err, debug);
        wx.showModal({
          title: '设备连接未就绪',
          content: `错误：${code || 'UNKNOWN'}\nBLE ID：${debugId}\n请返回“附近设备”重新连接后再试。`,
          showCancel: false
        });
      });
  },

  /**
   * 请求订阅消息授权
   * 洗涤完成和故障通知
   */
  requestSubscribe: function () {
    // 开发模式下不强制执行订阅
    wx.getSetting({
      withSubscriptions: true,
      success: (res) => {
        const subscribed = res.subscriptionsSetting &&
          res.subscriptionsSetting.itemSettings &&
          Object.keys(res.subscriptionsSetting.itemSettings).length > 0;

        if (!subscribed) {
          wx.requestSubscribeMessage({
            tmplIds: [
              '填写你的洗涤完成模板ID',   // 洗涤完成通知
              '填写你的故障通知模板ID'     // 故障通知
            ],
            success: (subRes) => {
              console.log('[订阅] 用户订阅结果:', subRes);
            },
            fail: (err) => {
              console.log('[订阅] 订阅请求失败（用户拒绝或系统限制）:', err);
            }
          });
        }
      }
    });
  },

  /**
   * 发送洗涤完成通知（通过云函数）
   */
  sendCompleteNotification: function () {
    const orderId = this.data._currentOrderId;
    const deviceName = this.data.bleDeviceName || '洗衣机';

    wx.cloud.callFunction({
      name: 'sendNotification',
      data: {
        type: 'washComplete',
        data: {
          deviceName: deviceName,
          endTime: new Date().toLocaleString()
        }
      }
    }).then(res => {
      console.log('[通知] 发送结果:', res);
    }).catch(err => {
      console.log('[通知] 发送失败（可接受）:', err);
    });
  },

  onWashComplete: function () {
    this.clearProgressTimer();
    this.setData({
      isWashing: false,
      progress: 100,
      remainingTime: 0
    });
    wx.showToast({ title: '清洗完成！', icon: 'success' });
    wx.vibrateLong();

    // 发送洗涤完成通知
    this.sendCompleteNotification();

    // 同步订单状态到云端
    const orderId = this.data._currentOrderId;
    if (orderId) {
      this.updateOrderRuntimeStatus(orderId, '已完成').catch(err => {
        console.error('更新订单状态失败:', err);
        wx.showToast({ title: '状态同步失败', icon: 'none' });
      });
    }
  },

  stopWash: function () {
    wx.showModal({
      title: '确认安全停止',
      content: '设备会先关闭当前执行器并回到安全最终位置。手机断开不会自动停止设备。',
      confirmColor: '#FF5252',
      success: (res) => {
        if (res.confirm) {
          this.setData({ commandBusy: true });
          wx.showLoading({ title: '请求安全停止...' });
          ble.sendProtocolCommand('abort_reset', {}, { timeoutMs: 5000, retries: 2 })
            .then(() => {
              wx.hideLoading();
              this.setData({
                commandBusy: false,
                statusText: '安全停止处理中'
              });
              wx.showToast({ title: '停止请求已确认', icon: 'success' });
              this.refreshDeviceStatus();
            }).catch((error) => {
              wx.hideLoading();
              this.setData({ commandBusy: false });
              wx.showToast({
                title: `停止失败：${error.code || '无确认'}`,
                icon: 'none'
              });
            });
        }
      }
    });
  },

  confirmLoad: function () {
    if (this.data.commandBusy) return;
    this.setData({ commandBusy: true });
    wx.showLoading({ title: '确认装载...' });
    ble.sendProtocolCommand('ack_load', {}, { retries: 2 })
      .then(() => {
        wx.hideLoading();
        this.setData({
          commandBusy: false,
          awaitingLoad: false,
          statusText: '设备开始执行'
        });
        wx.showToast({ title: '已开始清洗', icon: 'success' });
        this.refreshDeviceStatus();
      })
      .catch(error => {
        wx.hideLoading();
        this.setData({ commandBusy: false });
        wx.showToast({ title: `确认失败：${error.code || '无确认'}`, icon: 'none' });
      });
  },

  confirmUnload: function () {
    if (this.data.commandBusy) return;
    this.setData({ commandBusy: true });
    wx.showLoading({ title: '确认卸载...' });
    ble.sendProtocolCommand('ack_unload', {}, { retries: 2 })
      .then(() => {
        wx.hideLoading();
        this.setData({
          commandBusy: false,
          awaitingUnload: false,
          statusText: '设备继续执行 UV/收尾'
        });
        wx.showToast({ title: '已确认取出衣物', icon: 'success' });
        this.refreshDeviceStatus();
      })
      .catch(error => {
        wx.hideLoading();
        this.setData({ commandBusy: false });
        wx.showToast({ title: `确认失败：${error.code || '无确认'}`, icon: 'none' });
      });
  },

  skipUv: function () {
    if (this.data.commandBusy) return;
    this.setData({ commandBusy: true });
    ble.sendProtocolCommand('skip_uv', {}, { retries: 2 })
      .then(() => {
        this.setData({ commandBusy: false, canSkipUv: false });
        wx.showToast({ title: '已请求跳过 UV', icon: 'success' });
        this.refreshDeviceStatus();
      })
      .catch(error => {
        this.setData({ commandBusy: false });
        wx.showToast({ title: `跳过失败：${error.code || '无确认'}`, icon: 'none' });
      });
  },

  acknowledgeFault: function () {
    if (this.data.commandBusy) return;
    this.setData({ commandBusy: true });
    ble.sendProtocolCommand('ack_fault', {}, { retries: 2 })
      .then(() => {
        this.setData({ commandBusy: false });
        wx.showToast({ title: '故障确认已受理', icon: 'success' });
        this.refreshDeviceStatus();
      })
      .catch(error => {
        this.setData({ commandBusy: false });
        wx.showToast({ title: `复位失败：${error.code || '无确认'}`, icon: 'none' });
      });
  },

  requestStatusRefresh: function () {
    this.refreshDeviceStatus().then(() => {
      if (this.data.bleConnected) {
        wx.showToast({ title: '状态已刷新', icon: 'success' });
      }
    });
  },

  saveOrder: function (orderData) {
    return wx.cloud.callFunction({
      name: 'createOrderV2',
      data: { ...orderData }
    }).then(res => {
      if (res.result.code !== 0) {
        console.error('订单保存失败:', res.result.msg);
      }
      return res.result;
    }).catch(err => {
      console.error('订单保存失败:', err);
      return null;
    });
  },

  updateOrderRuntimeStatus: function (orderId, status, extra) {
    if (!orderId || !status) return Promise.resolve(null);
    return wx.cloud.callFunction({
      name: 'updateOrderRuntimeStatus',
      data: {
        orderId,
        status,
        ...(extra || {})
      }
    }).then(res => {
      if (!res.result || res.result.code !== 0) {
        throw new Error((res.result && res.result.msg) || '订单状态更新失败');
      }
      return res.result.data;
    }).catch(error => {
      console.error('[订单状态] 更新失败:', orderId, status, error);
      throw error;
    });
  },

  clearProgressTimer: function () {
    if (this.data.progressTimer) {
      clearInterval(this.data.progressTimer);
      this.setData({ progressTimer: null });
    }
  },

  // ========== 工具函数 ==========
  formatExpire: function (dateStr) {
    if (!dateStr) return '永久';
    const d = new Date(dateStr);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${m}-${day}`;
  },

  formatDate: function (date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  },

  formatTime: function (date) {
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  }
});
