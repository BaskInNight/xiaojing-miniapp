'use strict';

/*
 * test_swing_and_snapcast.js — 换向展示台能力开关 + 快照同步引导回归
 *
 * 目标（板测回归，覆盖本次修复）：
 *  1. capabilities 推送打开 diagSwingEnabled（position_swing_test）；
 *  2. protocol snapshot.capabilities 重建全部诊断开关（连接后不重发
 *     hello 也能显示电机按钮 —— 修复「按钮消失」的第一根因）；
 *  3. snapshot.capabilities 为 null 时自动补一次 hello；
 *  4. 新 UI 方法与 WXML bindtap 一一对应（防残影）。
 *
 * 实现方式：静态文本断言 + 方法集校验（与 test_page_contract.js 同风格，
 * 零依赖、可 node 直接运行）。
 */

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

// 1) capabilities 推送 → diagSwingEnabled
assert.ok(
  washJs.includes("diagSwingEnabled: diagList.indexOf('position_swing_test') >= 0") ||
  washJs.includes('diagSwingEnabled: diagList.indexOf(\'position_swing_test\') >= 0'),
  'capabilities 解析应包含 position_swing_test → diagSwingEnabled'
);
// 实际是 diagFlagsFromCapabilities 生成的
assert.ok(washJs.includes('diagSwingEnabled: diagList.indexOf(\'position_swing_test\') >= 0'),
  'diagSwingEnabled 由 diagFlagsFromCapabilities 统一解析');

// 2) snapshot 同步（连接后按钮必然可见）
assert.ok(washJs.includes('syncDiagnosticsFromSnapshot: function'),
  '应存在 syncDiagnosticsFromSnapshot');
assert.ok(washJs.includes('sendProtocolCommand(\'hello\', {}, { timeoutMs: 3000, retries: 0 })'),
  'cap=null 时自动 hello 兜底');
assert.ok(washJs.includes('...diagFlagsFromCapabilities(snap.capabilities, this.data.diagMbType)'),
  '快照同步复用 diagFlagsFromCapabilities');

assert.ok(washJs.includes('diagFlagsFromCapabilities(cap, currentMbType)'),
  '能力同步解析当前电机台架选择');
assert.ok(washJs.includes('mbTypes.indexOf(currentMbType) >= 0'),
  '能力重发时保留仍受支持的交替运行选择');
assert.ok(washJs.includes('snap.capabilities, this.data.diagMbType'),
  '快照同步传入当前电机台架选择');
assert.ok(washWxml.includes("正反交替约15秒"),
  '交替模式的二次确认按钮不得仍显示单方向');
assert.ok(washJs.includes('正反交替测试运行中'),
  '交替模式运行状态应明确显示正反交替');
assert.ok(washJs.includes('this.syncDiagnosticsFromSnapshot();'),
  'onLoad/onShow 调用快照同步');

// 3) position_swing 状态回显
for (const needle of [
  "ble.sendProtocolCommand('position_swing_test'",
  "ble.sendProtocolCommand('position_swing_cancel'",
]) {
  assert.ok(washJs.includes(needle), '缺少命令: ' + needle);
}
assert.ok(washJs.includes('status.position_swing'),
  '读取 status.position_swing 子块');
for (const m of ['startSwingTest', 'cancelSwingTest', 'resyncSwingStatus',
                 'pollSwing', 'readSwingSnapshot', 'syncSwing',
                 'mapSwingReject', 'markSwingStatusUnknown']) {
  assert.ok(new RegExp('\\b' + m + '\\s*:\\s*function\\s*\\(').test(washJs),
    '缺方法 ' + m);
}

// 4) WXML bindtap 均命中方法（残影拦截）
const bindingPattern = /\bbind(?:tap|change|input|confirm)="([^"]+)"/g;
const handlers = [];
let match;
while ((match = bindingPattern.exec(washWxml)) !== null) handlers.push(match[1]);
const missing = Array.from(new Set(handlers)).filter(name =>
  !new RegExp('\\b' + name + '\\s*:\\s*function\\s*\\(').test(washJs)
);
assert.deepStrictEqual(missing, [], 'WXML 引用但 JS 未定义: ' + missing.join(', '));

// 5) UI 门控：换向按钮只在 diagSwingEnabled 时显示
assert.ok(washWxml.includes('wx:if="{{diagSwingEnabled}}"'),
  '换向展示台块以 diagSwingEnabled 门控');
assert.ok(washWxml.includes('bindtap="startSwingTest"'), '开始按钮存在');
assert.ok(washWxml.includes('bindtap="cancelSwingTest"'), '停止按钮存在');

console.log('SWING_SNAPCAST_TESTS=2/2 PASS');
