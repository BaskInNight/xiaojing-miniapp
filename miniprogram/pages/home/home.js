const app = getApp();

// 判断字符串是否为经纬度坐标（非真实地址）
function isCoords(str) {
  return /^\d+\.\d{2,},\s*\d+\.\d{2,}$/.test(str);
}

Page({
  data: {
    currentLocation: '正在定位...',
    onlineDevices: [],
    coupons: 0
  },

  onShow: function () {
    this.loadDevices();
    this.setData({ coupons: app.globalData.coupons || 0 });
    // 智能定位：仅在无有效地址时才重新定位（避免每次 onShow 都闪一下）
    const saved = app.globalData.currentLocation || '';
    if (!saved || saved === '正在定位...' || saved === '解析地址中...' || isCoords(saved)) {
      this.getUserLocation();
    } else {
      this.setData({ currentLocation: saved });
    }
  },

  // ====================== 定位 ======================

  /**
   * 获取用户真实位置 → 逆地址解析 → 显示地址
   */
  getUserLocation: function () {
    wx.getSetting({
      success: (res) => {
        if (res.authSetting['scope.userLocation'] === false) {
          // 用户曾拒绝过 → 引导开启
          this.setData({ currentLocation: '定位未授权，点击重新定位' });
          return;
        }
        this._doGetLocation();
      },
      fail: () => {
        // 降级：保持上次位置
        this.setData({ currentLocation: app.globalData.currentLocation || '武汉理工大学（南湖校区）' });
      }
    });
  },

  // 刷新定位（用户点击"切换"时调用）
  refreshLocation: function () {
    wx.getSetting({
      success: (res) => {
        if (res.authSetting['scope.userLocation']) {
          this._doGetLocation();
        } else {
          wx.showModal({
            title: '需要位置权限',
            content: '开启位置权限后可查看附近设备',
            success: (r) => {
              if (r.confirm) wx.openSetting();
            }
          });
        }
      }
    });
  },

  _doGetLocation: function () {
    const that = this;
    wx.getLocation({
      type: 'wgs84',
      success: (loc) => {
        const coords = `${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}`;
        console.log('[LOCATION] getLocation success:', coords);

        that.setData({ currentLocation: '解析地址中...' });

        wx.cloud.callFunction({
          name: 'geocode',
          data: {
            latitude: loc.latitude,
            longitude: loc.longitude
          }
        }).then(res => {
          const r = res.result || {};
          // 4.0 geocode 返回 { code: 0, data: { address } }
          const address = (r.code === 0 && r.data && r.data.address) ? r.data.address : '';
          if (address && !isCoords(address)) {
            app.globalData.currentLocation = address;
            that.setData({ currentLocation: address });
          } else {
            if (!app.globalData.currentLocation || isCoords(app.globalData.currentLocation)) {
              app.globalData.currentLocation = coords;
              that.setData({ currentLocation: coords });
            }
          }
        }).catch((err) => {
          console.error('[LOCATION] geocode 云函数失败:', err);
          if (that.data.currentLocation === '解析地址中...') {
            app.globalData.currentLocation = coords;
            that.setData({ currentLocation: coords });
          }
        });
      },
      fail: (err) => {
        console.error('定位失败:', err);
        if (err.errCode === 2) {
          that.setData({ currentLocation: '定位未授权，点击重新定位' });
        } else {
          that.setData({ currentLocation: app.globalData.currentLocation || '武汉理工大学（南湖校区）' });
        }
      }
    });
  },

  // ====================== 设备 ======================

  loadDevices: function () {
    wx.cloud.callFunction({
      name: 'getDevices',
      data: {}
    }).then(res => {
      if (res.result.code === 0) {
        const cloudDevices = res.result.data.devices || [];
        if (cloudDevices.length > 0) {
          app.globalData.devices = cloudDevices;
        }
      }
    }).catch(err => {
      console.log('云函数获取设备失败，使用本地预设设备:', err);
      wx.showToast({ title: '设备加载失败', icon: 'none' });
    }).finally(() => {
      const devices = app.globalData.devices || [];
      // 显示在线或空闲的设备
      const onlineDevices = devices.filter(d =>
        d.status === 'online' || d.status === '空闲' || d.status === 'idle'
      );
      this.setData({ onlineDevices });
    });
  },

  selectDevice: function (e) {
    const device = e.currentTarget.dataset.device;
    if (device.fault) {
      wx.showToast({ title: '设备故障，暂不可用', icon: 'none' });
      return;
    }
    app.globalData.currentDevice = device;
    wx.navigateTo({ url: '/pages/devices/devices?from=wash' });
  },

  // ====================== 扫码 ======================

  /**
   * 扫码绑定设备
   * 扫描设备二维码 → 解析设备信息 → 自动连接 → 跳转洗涤页
   */
  scanQRCode: function () {
    const that = this;
    wx.scanCode({
      onlyFromCamera: true,
      scanType: ['qrCode'],
      success: (res) => {
        const raw = res.result;
        wx.showLoading({ title: '解析设备...' });

        try {
          // 支持两种二维码格式：
          // 1. JSON 格式: {"id":"device_001","bleName":"JJTP-A01","ip":"192.168.1.101"}
          // 2. 简写格式: JJTP-A01|192.168.1.101
          let deviceInfo = null;

          if (raw.startsWith('{')) {
            deviceInfo = JSON.parse(raw);
          } else if (raw.includes('|')) {
            const parts = raw.split('|');
            deviceInfo = {
              bleName: parts[0],
              ip: parts[1] || ''
            };
          } else {
            // 纯设备名称，去设备列表匹配
            deviceInfo = { bleName: raw };
          }

          // 匹配预设设备或使用扫码信息
          const preset = (app.globalData.devices || []).find(d =>
            d.bleName === deviceInfo.bleName || d.name === deviceInfo.bleName
          );

          if (preset) {
            app.globalData.currentDevice = {
              ...preset,
              ip: deviceInfo.ip || preset.ip
            };
          } else {
            app.globalData.currentDevice = {
              id: deviceInfo.bleName,
              name: deviceInfo.bleName,
              bleName: deviceInfo.bleName,
              ip: deviceInfo.ip || '',
              location: '扫码设备',
              status: 'online'
            };
          }

          wx.hideLoading();
          wx.showToast({ title: '设备识别成功', icon: 'success' });

          // 延时跳转到洗涤页
          setTimeout(() => {
            wx.navigateTo({ url: '/pages/devices/devices?from=wash' });
          }, 500);
        } catch (e) {
          wx.hideLoading();
          wx.showToast({ title: '无效的设备二维码', icon: 'none' });
        }
      },
      fail: (err) => {
        if (err.errMsg && !err.errMsg.includes('cancel')) {
          wx.showToast({ title: '扫码失败，请重试', icon: 'none' });
        }
      }
    });
  },

  goWash: function () {
    wx.navigateTo({ url: '/pages/wash/wash' });
  },

  goDevices: function () {
    wx.navigateTo({ url: '/pages/devices/devices' });
  },

  goProfile: function () {
    wx.switchTab({ url: '/pages/profile/profile' });
  },

  goRepair: function () {
    wx.navigateTo({ url: '/pages/repair/repair' });
  },

  callService: function () {
    wx.makePhoneCall({
      phoneNumber: '027-12345678'
    });
  },

  goTips: function () {
    wx.showModal({
      title: '洗衣小贴士',
      content: '1. 内衣袜子请使用独立模组\n2. 深色浅色衣物分开清洗\n3. 烘干温度不超过60℃\n4. 使用后请及时取出衣物\n5. 如遇故障请及时报修',
      showCancel: false,
      confirmText: '知道了'
    });
  }
});
