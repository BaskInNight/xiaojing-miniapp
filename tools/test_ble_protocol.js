'use strict';

const assert = require('assert');
const {
  JsonFrameAssembler,
  encodeUtf8,
  decodeUtf8,
  createCommand
} = require('../miniprogram/utils/ble_protocol');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('PASS', name);
}

test('UTF-8 round trip', () => {
  const value = '净界同频-ESP32-😀';
  assert.strictEqual(decodeUtf8(encodeUtf8(value)), value);
});

test('fragmented status reassembles', () => {
  const frame = JSON.stringify({
    v: 1,
    type: 'status',
    revision: 7,
    progress: 45,
    ble_connected: true
  });
  const bytes = encodeUtf8(frame);
  const assembler = new JsonFrameAssembler();
  let output = [];
  for (let i = 0; i < bytes.length; i += 7) {
    output = output.concat(assembler.push(bytes.slice(i, i + 7)));
  }
  assert.strictEqual(output.length, 1);
  assert.strictEqual(output[0].progress, 45);
});

test('multiple frames in one notification split', () => {
  const joined = encodeUtf8(
    '{"v":1,"type":"ack","seq":9,"ok":true,"code":"OK","detail":0}' +
    '{"v":1,"type":"status","progress":2}'
  );
  const output = new JsonFrameAssembler().push(joined);
  assert.strictEqual(output.length, 2);
  assert.strictEqual(output[0].seq, 9);
  assert.strictEqual(output[1].progress, 2);
});

test('braces and escaped quotes inside strings do not terminate frame', () => {
  const frame = '{"v":1,"type":"nack","code":"A_{_\\"_}_B"}';
  const output = new JsonFrameAssembler().push(encodeUtf8(frame));
  assert.strictEqual(output.length, 1);
  assert.strictEqual(output[0].code, 'A_{_"_}_B');
});

test('oversized frame is rejected and assembler recovers', () => {
  const assembler = new JsonFrameAssembler(32);
  assert.throws(() => assembler.push(encodeUtf8('{"x":"' + 'a'.repeat(40))), /TOO_LARGE/);
  const output = assembler.push(encodeUtf8('{"ok":true}'));
  assert.strictEqual(output[0].ok, true);
});

test('non-JSON prefix is rejected', () => {
  assert.throws(() => new JsonFrameAssembler().push(encodeUtf8('P,50')), /BAD_START/);
});

test('V1 command envelope is exact', () => {
  assert.deepStrictEqual(createCommand(12, 'start_formal', {
    allow_uv: true,
    allow_dry: false
  }), {
    v: 1,
    type: 'cmd',
    seq: 12,
    cmd: 'start_formal',
    allow_uv: true,
    allow_dry: false
  });
});

test('sequence zero is rejected', () => {
  assert.throws(() => createCommand(0, 'hello'), /SEQ_INVALID/);
});

console.log(`BLE_PROTOCOL_TESTS=${passed}/8 PASS`);
