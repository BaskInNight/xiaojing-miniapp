const version = require('./utils/version.js');
const ble = require('./utils/ble.js');

App({
  onLaunch: function () {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
    } else {
      wx.cloud.init({
        env: 'cloud1-d6g8uxp6ha8bb9404', // 替换为你的云环境ID
        traceUser: true,
      });
    }

    // 检查登录状态，未登录则跳转登录页
    this.checkLogin();

    // 初始化蓝牙适配器
    this.initBluetooth();

    // 预设设备列表（同时作为云函数降级数据）
    const presetDevices = [
      {
        id: 'device_001',
        name: 'JJTP-A01',
        location: '南湖校区 2号宿舍楼 1F',
        status: '空闲',
        ip: '192.168.1.101',     // 局域网IP（实物设备）
        bleName: 'JJTP-A01'
      },
      {
        id: 'device_002',
        name: 'JJTP-A02',
        location: '南湖校区 3号宿舍楼 2F',
        status: '空闲',
        ip: '192.168.1.102',
        bleName: 'JJTP-A02'
      }
    ];

    this.globalData = {
      userInfo: null,
      openid: '',
      phoneBound: false,
      currentDevice: null,
      currentLocation: '正在定位...',
      coupons: 2,
      // 设备列表（首页 / 附近设备页面使用）
      devices: presetDevices,
      // 蓝牙相关
      bleConnected: false,
      bleDeviceId: '',
      bleDeviceName: '',
      bleServiceId: '',
      bleWriteCharId: '',
      bleNotifyCharId: '',
      appVersion: version.MINIAPP_VERSION
    };

    // 已登录用户静默获取 openid 和用户信息
    const loginState = wx.getStorageSync('loginState') || {};
    if (loginState.loggedIn) {
      this.login();
    }
  },

  // 检查登录状态，未登录则跳转登录页
  checkLogin: function () {
    const loginState = wx.getStorageSync('loginState') || {};
    if (!loginState.loggedIn) {
      setTimeout(() => {
        wx.reLaunch({ url: '/pages/login/login' });
      }, 100);
    }
  },

  // 初始化蓝牙适配器
  initBluetooth: function () {
    const deviceInfo = typeof wx.getDeviceInfo === 'function'
      ? wx.getDeviceInfo()
      : {};
    if (deviceInfo.platform === 'devtools') {
      console.info('开发者工具不支持 Windows BLE，跳过适配器初始化；请使用手机真机验证');
      return;
    }

    wx.openBluetoothAdapter({
      success: () => {
        console.log('蓝牙适配器初始化成功');
      },
      fail: (err) => {
        console.error('蓝牙适配器初始化失败:', err);
        if (err.errCode === 10001) {
          wx.showToast({ title: '请开启手机蓝牙', icon: 'none' });
        }
      }
    });
  },

  login: function () {
    wx.cloud.callFunction({
      name: 'login',
      data: {},
      success: res => {
        if (res.result.code === 0) {
          this.globalData.openid = res.result.data.openid;
        }

        // 登录成功后获取用户信息（优惠券数量等）
        wx.cloud.callFunction({
          name: 'getUserProfile',
          data: {}
        }).then(profileRes => {
          if (profileRes.result.code === 0) {
            this.globalData.coupons = profileRes.result.data.coupons || 0;
          }
        }).catch(err => {
          console.error('获取用户信息失败:', err);
        });
      },
      fail: err => {
        console.error('登录失败:', err);
      }
    });
  },

  // 断开蓝牙连接
  disconnectBLE: function () {
    if (this.globalData.bleDeviceId || ble.getConnectedDeviceId()) {
      ble.disconnect();
      this.globalData.bleConnected = false;
      this.globalData.bleDeviceId = '';
      this.globalData.bleDeviceName = '';
      this.globalData.bleServiceId = '';
      this.globalData.bleWriteCharId = '';
      this.globalData.bleNotifyCharId = '';
      this.globalData.currentDevice = null;
    }
  }
});
