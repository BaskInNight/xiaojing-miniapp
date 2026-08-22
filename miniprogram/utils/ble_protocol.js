'use strict';

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 2048;

function encodeUtf8(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xDC00 && low <= 0xDFFF) {
        code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
        i++;
      }
    }

    if (code <= 0x7F) {
      bytes.push(code);
    } else if (code <= 0x7FF) {
      bytes.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F));
    } else if (code <= 0xFFFF) {
      bytes.push(
        0xE0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3F),
        0x80 | (code & 0x3F)
      );
    } else {
      bytes.push(
        0xF0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3F),
        0x80 | ((code >> 6) & 0x3F),
        0x80 | (code & 0x3F)
      );
    }
  }
  return new Uint8Array(bytes);
}

function decodeUtf8(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let output = '';
  for (let i = 0; i < bytes.length;) {
    const first = bytes[i++];
    let code;
    let needed;

    if (first <= 0x7F) {
      code = first;
      needed = 0;
    } else if ((first & 0xE0) === 0xC0) {
      code = first & 0x1F;
      needed = 1;
    } else if ((first & 0xF0) === 0xE0) {
      code = first & 0x0F;
      needed = 2;
    } else if ((first & 0xF8) === 0xF0) {
      code = first & 0x07;
      needed = 3;
    } else {
      output += '\uFFFD';
      continue;
    }

    if (i + needed > bytes.length) {
      output += '\uFFFD';
      break;
    }

    let valid = true;
    for (let j = 0; j < needed; j++) {
      const next = bytes[i++];
      if ((next & 0xC0) !== 0x80) {
        valid = false;
        i--;
        break;
      }
      code = (code << 6) | (next & 0x3F);
    }
    if (!valid) {
      output += '\uFFFD';
      continue;
    }

    if (code <= 0xFFFF) {
      output += String.fromCharCode(code);
    } else {
      code -= 0x10000;
      output += String.fromCharCode(
        0xD800 | ((code >> 10) & 0x3FF),
        0xDC00 | (code & 0x3FF)
      );
    }
  }
  return output;
}

function arrayBufferFromBytes(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function isWhitespaceByte(byte) {
  return byte === 0x20 || byte === 0x09 || byte === 0x0A || byte === 0x0D;
}

class JsonFrameAssembler {
  constructor(maxBytes) {
    this.maxBytes = maxBytes || MAX_FRAME_BYTES;
    this.reset();
  }

  reset() {
    this.bytes = [];
    this.active = false;
    this.depth = 0;
    this.inString = false;
    this.escaped = false;
  }

  push(input) {
    const source = input instanceof Uint8Array ? input : new Uint8Array(input);
    const frames = [];

    for (let i = 0; i < source.length; i++) {
      const byte = source[i];

      if (!this.active) {
        if (isWhitespaceByte(byte)) continue;
        if (byte !== 0x7B) {
          throw new Error('BLE_FRAME_BAD_START');
        }
        this.active = true;
        this.depth = 1;
        this.inString = false;
        this.escaped = false;
        this.bytes = [byte];
        continue;
      }

      this.bytes.push(byte);
      if (this.bytes.length > this.maxBytes) {
        this.reset();
        throw new Error('BLE_FRAME_TOO_LARGE');
      }

      if (this.inString) {
        if (this.escaped) {
          this.escaped = false;
        } else if (byte === 0x5C) {
          this.escaped = true;
        } else if (byte === 0x22) {
          this.inString = false;
        }
        continue;
      }

      if (byte === 0x22) {
        this.inString = true;
      } else if (byte === 0x7B || byte === 0x5B) {
        this.depth++;
      } else if (byte === 0x7D || byte === 0x5D) {
        this.depth--;
        if (this.depth < 0) {
          this.reset();
          throw new Error('BLE_FRAME_UNBALANCED');
        }
        if (this.depth === 0) {
          const text = decodeUtf8(new Uint8Array(this.bytes));
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch (error) {
            this.reset();
            throw new Error('BLE_FRAME_BAD_JSON');
          }
          frames.push(parsed);
          this.reset();
        }
      }
    }

    return frames;
  }
}

function createCommand(seq, command, payload) {
  if (!Number.isInteger(seq) || seq <= 0 || seq > 0xFFFFFFFF) {
    throw new Error('BLE_SEQ_INVALID');
  }
  if (typeof command !== 'string' || !command) {
    throw new Error('BLE_COMMAND_INVALID');
  }
  return Object.assign({
    v: PROTOCOL_VERSION,
    type: 'cmd',
    seq: seq,
    cmd: command
  }, payload || {});
}

module.exports = {
  PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  JsonFrameAssembler,
  encodeUtf8,
  decodeUtf8,
  arrayBufferFromBytes,
  createCommand
};
