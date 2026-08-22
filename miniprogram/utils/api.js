/**
 * utils/api.js - 局域网（LAN）设备控制 API
 *
 * ============================================================
 *  LAN HTTP 指令映射（与 BLE 指令等效）
 * ============================================================
 *
 *  ▸ 完整通讯指令词典: miniprogram/docs/COMMAND_DICTIONARY.md
 *
 *  GET  /api/info
 *    → 返回: {"name":"JJTP-A01","status":"idle","progress":0,"ip":"192.168.1.101"}
 *
 *  POST /api/wash/start
 *    → 发送: {"steps":{"soak":{...},"wash":{...},"rinse":{...},"dry":{...}},"totalTime":30}
 *    → 返回: {"success":true}
 *
 *  POST /api/wash/stop
 *    → 返回: {"success":true}
 *
 *  GET  /api/wash/progress
 *    → 返回: {"progress":45,"remainingTime":15,"status":"running"}
 *
 * 工作流程：
 *   1. 通过 BLE 扫描发现设备，获取设备信息（含 IP 地址）
 *   2. 连接设备后，将设备 IP 保存到 app.globalData.currentDevice.ip
 *   3. 所有控制指令通过 HTTP LAN 发送给设备
 *
 * 实物洗衣机对接（HTTP LAN API 规范）：
 *   洗衣机固件需在局域网监听 HTTP 服务，实现以上端点。
 *   固件参考实现：export_hardware_control/esp32_example/esp32_washing_machine.ino
 */

const app = getApp();

/**
 * 获取当前设备的基础 URL（优先使用 LAN IP）
 */
function getBaseUrl() {
  const device = app.globalData.currentDevice;
  if (device && device.ip) {
    return `http://${device.ip}`;
  }
  // 尝试从 BLE 连接的设备名匹配预设 IP
  const bleName = app.globalData.bleDeviceName;
  if (bleName) {
    const preset = (app.globalData.devices || []).find(d => d.bleName === bleName);
    if (preset && preset.ip) {
      return `http://${preset.ip}`;
    }
  }
  return '';
}

/**
 * 通用 HTTP 请求（含自动重试）
 * @param {string} method  HTTP 方法
 * @param {string} path    请求路径
 * @param {object} data    请求体数据
 * @param {number} retries 剩余重试次数（默认 3 次）
 * @param {number} delay   重试等待基数 ms（指数退避）
 */
function request(method, path, data = {}, retries = 3, delay = 1000) {
  return new Promise((resolve, reject) => {
    const baseUrl = getBaseUrl();

    if (!baseUrl) {
      reject(new Error('未指定设备IP，请通过蓝牙连接设备获取IP'));
      return;
    }

    wx.request({
      url: `${baseUrl}${path}`,
      method: method,
      data: data,
      timeout: 10000,
      header: { 'Content-Type': 'application/json' },
      success: (res) => {
        if (res.statusCode === 200) {
          resolve(res.data);
        } else if (res.statusCode >= 500 && retries > 0) {
          // 服务端错误可重试
          console.warn(`[api] HTTP ${res.statusCode}, 剩余重试 ${retries} 次`);
          setTimeout(() => {
            resolve(request(method, path, data, retries - 1, delay * 2));
          }, delay);
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      },
      fail: (err) => {
        if (retries > 0) {
          console.warn(`[api] 请求失败 (${err.errMsg}), ${retries} 次后重试`);
          setTimeout(() => {
            resolve(request(method, path, data, retries - 1, delay * 2));
          }, delay);
        } else {
          reject(new Error(`网络请求失败: ${err.errMsg}`));
        }
      }
    });
  });
}

/**
 * 获取设备信息（用于验证 LAN 连接）
 * @param {string} ip - 设备 IP 地址（可选，默认使用 currentDevice.ip）
 */
function getDeviceInfo(ip) {
  const targetIp = ip || (app.globalData.currentDevice && app.globalData.currentDevice.ip);
  if (!targetIp) {
    return Promise.reject(new Error('未指定设备IP'));
  }

  // 验证成功后，将 IP 缓存到当前设备
  const cacheIp = () => {
    if (app.globalData.currentDevice) {
      app.globalData.currentDevice.ip = targetIp;
    }
  };

  const doRequest = (retries = 2, delay = 500) => {
    return new Promise((resolve, reject) => {
      wx.request({
        url: `http://${targetIp}/api/info`,
        method: 'GET',
        timeout: 3000,
        success: (res) => {
          if (res.statusCode === 200) {
            cacheIp();
            resolve(res.data);
          } else if (retries > 0) {
            setTimeout(() => resolve(doRequest(retries - 1, delay * 2)), delay);
          } else {
            reject(new Error('设备无响应'));
          }
        },
        fail: (err) => {
          if (retries > 0) {
            setTimeout(() => resolve(doRequest(retries - 1, delay * 2)), delay);
          } else {
            reject(new Error(err.errMsg));
          }
        }
      });
    });
  };

  return doRequest();
}

/**
 * 启动清洗（通过 LAN HTTP）
 */
function startWash(params) {
  return request('POST', '/api/wash/start', params);
}

/**
 * 停止清洗
 */
function stopWash() {
  return request('POST', '/api/wash/stop');
}

/**
 * 获取清洗进度
 */
function getProgress() {
  return request('GET', '/api/wash/progress');
}

module.exports = {
  getDeviceInfo,
  startWash,
  stopWash,
  getProgress
};
