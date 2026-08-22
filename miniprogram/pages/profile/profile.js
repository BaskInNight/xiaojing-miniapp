const app = getApp();
const helper = require('../../utils/helper.js');
const version = require('../../utils/version.js');
const ble = require('../../utils/ble.js');

Page({
  data: {
    nickName: '用户',
    avatarUrl: '',
    coupons: 0,
    totalOrders: 0,
    totalSpend: 0,
    loading: true,
    couponList: [],
    loggedIn: false,
    appVersion: version.MINIAPP_VERSION,
    bleDebugText: '',
    voiceWifiSsid: '',
    voiceWifiPassword: '',
    voiceWifiProvisioning: false,
    voiceProviderOptions: ['MiMo 直连', '边缘大模型网关（可选）'],
    voiceProviderValues: ['mimo_direct', 'ai_gateway'],
    voiceProviderIndex: 0,
    voiceApiKey: '',
    voiceModel: 'mimo-v2.5',
    voiceCredentialProvisioning: false,
    showDemoSecrets: false
  },

  onShow: function () {
    const loginState = wx.getStorageSync('loginState') || {};
    this.setData({ loggedIn: loginState.loggedIn || false });
    if (this.data.loggedIn) {
      this.loadUserProfile();
      this.loadCoupons();
    }
    this.setData({
      coupons: app.globalData.coupons || 0,
      appVersion: app.globalData.appVersion || version.MINIAPP_VERSION,
      bleDebugText: this.formatBleDebug()
    });
  },

  formatBleDebug: function () {
    const snapshot = ble.getProtocolSnapshot();
    const last = ble.getLastConnectDebug && ble.getLastConnectDebug();
    const parts = [
      `connected=${snapshot.connected ? 1 : 0}`,
      `ready=${snapshot.protocolReady ? 1 : 0}`,
      `id=${snapshot.deviceId || '-'}`
    ];
    if (last) {
      parts.push(`last=${last.source}`);
      parts.push(`lastId=${last.deviceId || '-'}`);
      parts.push(`valid=${last.valid ? 1 : 0}`);
      if (last.errorCode) parts.push(`err=${last.errorCode}`);
    }
    return parts.join(' | ');
  },

  loadCoupons: function () {
    wx.cloud.callFunction({
      name: 'getUserCoupons',
      data: {}
    }).then(res => {
      if (res.result.code === 0) {
        this.setData({ couponList: res.result.data.coupons || [] });
      }
    }).catch(err => {
      console.error('加载优惠券列表失败:', err);
      wx.showToast({ title: '优惠券加载失败', icon: 'none' });
    });
  },

  loadUserProfile: function () {
    this.setData({ loading: true });

    wx.cloud.callFunction({
      name: 'getUserProfile',
      data: {}
    }).then(res => {
      if (res.result.code === 0) {
        const profile = res.result.data;
        this.setData({
          coupons: profile.coupons || 0,
          nickName: profile.nickName || '用户',
          avatarUrl: profile.avatarUrl || '',
          totalOrders: profile.totalOrders || 0,
          totalSpend: profile.totalSpend || 0
        });
        app.globalData.coupons = profile.coupons || 0;
      }
    }).catch(err => {
      console.error('获取用户信息失败:', err);
      wx.showToast({ title: '加载失败', icon: 'none' });
    }).finally(() => {
      this.setData({ loading: false });
    });
  },

  formatExpire: function (dateStr) {
    return helper.formatExpire(dateStr);
  },

  goOrders: function () {
    wx.switchTab({ url: '/pages/orders/orders' });
  },

  goBooking: function () {
    wx.switchTab({ url: '/pages/booking/booking' });
  },

  goWash: function () {
    wx.navigateTo({ url: '/pages/wash/wash' });
  },

  goRepair: function () {
    wx.navigateTo({ url: '/pages/repair/repair' });
  },

  callService: function () {
    wx.makePhoneCall({ phoneNumber: '027-12345678' });
  },

  showTips: function () {
    wx.showModal({
      title: '使用说明',
      content: '1. 打开手机蓝牙\n2. 进入"扫一扫"扫描设备\n3. 选择套餐并自定义流程\n4. 确认订单并支付\n5. 等待清洗完成取衣',
      showCancel: false,
      confirmText: '知道了'
    });
  },

  goLogin: function () {
    wx.navigateTo({ url: '/pages/login/login' });
  },

  logout: function () {
    wx.showModal({
      title: '退出登录',
      content: '确定退出当前账号吗？',
      confirmColor: '#FF5252',
      success: (res) => {
        if (res.confirm) {
          wx.removeStorageSync('loginState');
          app.globalData.openid = '';
          app.globalData.loggedIn = false;
          this.setData({ loggedIn: false });
          wx.showToast({ title: '已退出', icon: 'success' });
        }
      }
    });
  },

  onChooseAvatar: function (e) {
    const tempPath = e.detail.avatarUrl;
    if (!tempPath) return;

    wx.showLoading({ title: '上传头像...' });
    const cloudPath = 'avatars/' + app.globalData.openid + '_' + Date.now() + '.png';
    wx.cloud.uploadFile({
      cloudPath: cloudPath,
      filePath: tempPath
    }).then(res => {
      const fileUrl = res.fileID;
      return wx.cloud.callFunction({
        name: 'login',
        data: { avatarUrl: fileUrl }
      });
    }).then(res => {
      wx.hideLoading();
      if (res.result.code === 0) {
        this.loadUserProfile();
        wx.showToast({ title: '头像已更新', icon: 'success' });
      }
    }).catch(err => {
      wx.hideLoading();
      console.error('头像上传失败:', err);
      wx.showToast({ title: '头像更新失败', icon: 'none' });
    });
  },

  onNicknameChange: function (e) {
    const nickName = e.detail.value;
    if (!nickName || nickName === this.data.nickName) return;

    wx.showLoading({ title: '保存昵称...' });
    wx.cloud.callFunction({
      name: 'login',
      data: { nickName }
    }).then(res => {
      wx.hideLoading();
      if (res.result.code === 0) {
        this.setData({ nickName });
        wx.showToast({ title: '昵称已更新', icon: 'success' });
      }
    }).catch(err => {
      wx.hideLoading();
      console.error('昵称保存失败:', err);
      wx.showToast({ title: '昵称保存失败', icon: 'none' });
    });
  },

  onVoiceWifiSsidInput: function (e) {
    this.setData({ voiceWifiSsid: String(e.detail.value || '').trim() });
  },

  onVoiceWifiPasswordInput: function (e) {
    this.setData({ voiceWifiPassword: String(e.detail.value || '') });
  },

  toggleDemoSecrets: function () {
    this.setData({ showDemoSecrets: !this.data.showDemoSecrets });
  },

  provisionVoiceWifi: async function () {
    if (this.data.voiceWifiProvisioning) return;
    const ssid = String(this.data.voiceWifiSsid || '').trim();
    const password = String(this.data.voiceWifiPassword || '');
    if (!ssid || ssid.length > 32) {
      wx.showToast({ title: 'SSID 长度需为 1-32', icon: 'none' });
      return;
    }
    if (password.length !== 0 &&
        (password.length < 8 || password.length > 63)) {
      wx.showToast({ title: '密码长度需为 8-63', icon: 'none' });
      return;
    }
    const snapshot = ble.getProtocolSnapshot();
    if (!snapshot.connected || !snapshot.protocolReady) {
      wx.showToast({ title: '请先连接小净设备', icon: 'none' });
      return;
    }
    this.setData({ voiceWifiProvisioning: true });
    wx.showLoading({ title: '正在写入 Wi-Fi' });
    try {
      const ack = await ble.sendProtocolCommand(
        'provision_wifi', { ssid, password },
        { timeoutMs: 8000, retries: 1 }
      );
      if (!ack || ack.code !== 'WIFI_CONNECTING') {
        throw new Error((ack && ack.code) || 'BAD_ACK');
      }
      this.setData({ voiceWifiPassword: '' });
      wx.showToast({ title: '已保存，正在联网', icon: 'success' });
    } catch (error) {
      console.error('[Voice Wi-Fi] provisioning failed:', error);
      wx.showToast({
        title: `配网失败: ${error.code || error.message || 'UNKNOWN'}`,
        icon: 'none',
        duration: 3000
      });
    } finally {
      wx.hideLoading();
      this.setData({
        voiceWifiProvisioning: false,
        bleDebugText: this.formatBleDebug()
      });
    }
  },

  onVoiceProviderChange: function (e) {
    const index = Number(e.detail.value) || 0;
    this.setData({ voiceProviderIndex: index });
  },

  onVoiceApiKeyInput: function (e) {
    this.setData({ voiceApiKey: String(e.detail.value || '').trim() });
  },

  onVoiceModelInput: function (e) {
    this.setData({ voiceModel: String(e.detail.value || '').trim() });
  },

  configureVoiceProvider: async function () {
    if (this.data.voiceCredentialProvisioning) return;
    const apiKey = String(this.data.voiceApiKey || '').trim();
    const model = String(this.data.voiceModel || '').trim();
    const provider = this.data.voiceProviderValues[
      this.data.voiceProviderIndex] || 'mimo_direct';
    if (!apiKey || apiKey.length > 255 || !/^[!-~]+$/.test(apiKey)) {
      wx.showToast({ title: 'API Key 格式或长度不正确', icon: 'none' });
      return;
    }
    if (model.length > 63 || (model && !/^[!-~]+$/.test(model))) {
      wx.showToast({ title: '模型名称格式不正确', icon: 'none' });
      return;
    }
    const snapshot = ble.getProtocolSnapshot();
    if (!snapshot.connected || !snapshot.protocolReady) {
      wx.showToast({ title: '请先连接小净设备', icon: 'none' });
      return;
    }
    if (!snapshot.secureWriteCharId) {
      wx.showToast({ title: '当前固件不支持安全凭据配置', icon: 'none' });
      return;
    }
    this.setData({ voiceCredentialProvisioning: true });
    wx.showLoading({ title: '正在安全写入' });
    try {
      const ack = await ble.sendCredentialCommand('configure_voice', {
        provider,
        api_key: apiKey,
        model
      }, { timeoutMs: 12000 });
      if (!ack || ack.code !== 'VOICE_CONFIG_SAVED') {
        throw new Error((ack && ack.code) || 'BAD_ACK');
      }
      this.setData({ voiceApiKey: '' });
      wx.showModal({
        title: 'AI 配置已保存',
        content: '设备将在约 2 秒后自动重启。重新连接后即可使用新的 AI 服务。',
        showCancel: false
      });
    } catch (error) {
      const code = error.code || error.message || 'UNKNOWN';
      const hint = code === 'PHYSICAL_AUTH_REQUIRED'
        ? '请先在设备上长按按钮1，再于60秒内重试。'
        : `写入失败：${code}`;
      console.error('[Voice Credentials] provisioning failed:', error);
      wx.showModal({
        title: 'AI 配置未保存',
        content: hint,
        showCancel: false
      });
    } finally {
      wx.hideLoading();
      this.setData({
        voiceCredentialProvisioning: false,
        bleDebugText: this.formatBleDebug()
      });
    }
  },

  watchAd: function () {
    helper.watchAdForCoupon('adunit-xxxxxxxxxxxxxxxx', () => {
      this.loadUserProfile();
    });
  }
});
