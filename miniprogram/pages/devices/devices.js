const app = getApp();
const ble = require('../../utils/ble.js');

Page({
  data: {
    scanning: false,
    devices: [],
    from: '',
    cloudDevices: []  // 从云端获取的设备信息（含状态、故障标记）
  },

  onLoad: function (options) {
    this.setData({ from: options.from || '' });

    // 加载云端设备信息（用于标记故障等状态）
    this.loadCloudDevices();

    // 页面加载时自动扫描一次
    this.startScan();
  },

  loadCloudDevices: function () {
    wx.cloud.callFunction({
      name: 'getDevices',
      data: {}
    }).then(res => {
      if (res.result.code === 0) {
        this.setData({ cloudDevices: res.result.data.devices || [] });
      }
    }).catch(err => {
      console.error('获取云端设备列表失败:', err);
      wx.showToast({ title: '设备状态加载失败', icon: 'none' });
    });
  },

  // 获取设备的云端状态
  getDeviceStatus: function (bleName) {
    const cloud = this.data.cloudDevices.find(d => d.bleName === bleName || d.name === bleName);
    return cloud || null;
  },

  onUnload: function () {
    ble.stopScan();
  },

  // 扫码绑定设备
  scanQRCode: function () {
    wx.scanCode({
      onlyFromCamera: true,
      scanType: ['qrCode'],
      success: (res) => {
        const raw = res.result;
        wx.showLoading({ title: '解析设备...' });

        try {
          let deviceInfo = null;
          if (raw.startsWith('{')) {
            deviceInfo = JSON.parse(raw);
          } else if (raw.includes('|')) {
            const parts = raw.split('|');
            deviceInfo = { bleName: parts[0], ip: parts[1] || '' };
          } else {
            deviceInfo = { bleName: raw };
          }

          const cloudInfo = this.getDeviceStatus(deviceInfo.bleName);
          if (cloudInfo && cloudInfo.fault) {
            wx.hideLoading();
            wx.showToast({ title: '设备故障，暂不可用', icon: 'none' });
            return;
          }

          if (!deviceInfo.bleName ||
              !String(deviceInfo.bleName).startsWith(ble.DEVICE_NAME_PREFIX)) {
            throw new Error('二维码中的设备名无效');
          }

          // 二维码只包含广播名，微信 BLE 连接必须使用扫描得到的真实
          // deviceId（Android MAC / iOS UUID），不能用 bleName 替代。
          ble.stopScan();
          ble.scanDevices(8000)
            .then(devices => {
              const matched = devices.find(item => item.name === deviceInfo.bleName);
              if (!matched) throw new Error('附近未发现二维码对应设备');

              app.globalData.currentDevice = {
                bleName: matched.name,
                ip: deviceInfo.ip || '',
                name: matched.name,
                location: '扫码设备',
                status: 'online'
              };

              wx.hideLoading();
              wx.showToast({ title: '设备识别成功', icon: 'success' });
              setTimeout(() => {
                wx.navigateTo({
                  url: '/pages/wash/wash?deviceId=' +
                    encodeURIComponent(matched.deviceId) +
                    '&deviceName=' + encodeURIComponent(matched.name)
                });
              }, 300);
            })
            .catch(error => {
              wx.hideLoading();
              console.error('扫码设备匹配失败:', error);
              wx.showToast({
                title: error.message || '附近未发现该设备',
                icon: 'none'
              });
            });
        } catch (e) {
          wx.hideLoading();
          wx.showToast({ title: e.message || '无效的设备二维码', icon: 'none' });
        }
      },
      fail: (err) => {
        if (err.errMsg && !err.errMsg.includes('cancel')) {
          wx.showToast({ title: '扫码失败，请重试', icon: 'none' });
        }
      }
    });
  },

  // 开始扫描
  startScan: function () {
    this.setData({ scanning: true, devices: [] });

    ble.scanDevices(10000)
      .then((devices) => {
        // 合并云端设备状态（故障标记等）
        const enriched = devices.map(d => {
          const cloudInfo = this.getDeviceStatus(d.name);
          if (cloudInfo) {
            d._fault = cloudInfo.fault || false;
            d._faultReason = cloudInfo.faultReason || '';
          }
          return d;
        });
        const snapshot = ble.getProtocolSnapshot();
        if (snapshot.connected && snapshot.protocolReady && snapshot.deviceId &&
            !enriched.some(item => item.deviceId === snapshot.deviceId)) {
          enriched.unshift({
            deviceId: snapshot.deviceId,
            name: app.globalData.bleDeviceName || 'JJTP-XIAOJING',
            RSSI: -45,
            _connected: true
          });
        }
        this.setData({
          scanning: false,
          devices: enriched
        });

        if (enriched.length === 0) {
          wx.showToast({ title: '未发现设备', icon: 'none' });
        }
      })
      .catch((err) => {
        this.setData({ scanning: false });
        console.error('扫描失败:', err);
        
        if (err.errCode === 10001) {
          wx.showModal({
            title: '蓝牙未开启',
            content: '请先在手机设置中开启蓝牙',
            showCancel: false
          });
        }
      });
  },

  // 选择设备
  selectDevice: function (e) {
    const device = e.currentTarget.dataset.device;

    // 检查设备是否故障
    const cloudInfo = this.getDeviceStatus(device.name);
    if (cloudInfo && cloudInfo.fault) {
      wx.showToast({ title: '设备故障，暂不可用', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '连接中...' });

    ble.connectDevice(device.deviceId)
      .then((info) => {
        wx.hideLoading();

        // 保存到全局
        app.globalData.bleConnected = true;
        app.globalData.bleDeviceId = device.deviceId;
        app.globalData.bleDeviceName = device.name;
        app.globalData.bleServiceId = info.serviceId;
        app.globalData.bleWriteCharId = info.writeCharId;
        app.globalData.bleNotifyCharId = info.notifyCharId;

        wx.showToast({ title: '连接成功', icon: 'success' });

        // 连接成功后，同步设备状态到云端（online）
        wx.cloud.callFunction({
          name: 'updateDeviceStatus',
          data: {
            deviceId: device.name,
            status: 'online'
          }
        }).catch(err => {
          console.warn('更新设备状态失败:', err);
        });

        // 返回上一页并传递设备信息
        const pages = getCurrentPages();
        const prevPage = pages[pages.length - 2];

        if (prevPage && this.data.from === 'wash') {
          // 更新洗涤页的设备信息
          prevPage.setData({
            bleConnected: true,
            bleDeviceId: device.deviceId,
            bleDeviceName: device.name,
            bleServiceId: info.serviceId,
            bleWriteCharId: info.writeCharId,
            bleNotifyCharId: info.notifyCharId,
            bleRSSI: (info.RSSI || device.RSSI) + 'dBm'
          });
        }

        setTimeout(() => {
          wx.navigateBack();
        }, 800);
      })
      .catch((err) => {
        wx.hideLoading();
        console.error('连接失败:', err);
        wx.showToast({ title: '连接失败，请靠近设备重试', icon: 'none' });
      });
  }
});
