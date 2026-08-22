const app = getApp();

Page({
  data: {
    agreed: false,
    logging: false,
    avatarUrl: '',
    nickName: ''
  },

  toggleAgree: function () {
    this.setData({ agreed: !this.data.agreed });
  },

  onChooseAvatar: function (e) {
    const avatarUrl = e.detail.avatarUrl;
    if (avatarUrl) {
      this.setData({ avatarUrl });
    }
  },

  onNicknameInput: function (e) {
    this.setData({ nickName: e.detail.value });
  },

  doLogin: function () {
    if (!this.data.agreed) {
      wx.showToast({ title: '请先同意用户协议', icon: 'none' });
      return;
    }

    this.setData({ logging: true });

    wx.cloud.callFunction({
      name: 'login',
      data: {
        nickName: this.data.nickName || '',
        avatarUrl: this.data.avatarUrl || ''
      }
    }).then(res => {
      if (res.result.code === 0) {
        app.globalData.openid = res.result.data.openid;
        app.globalData.loggedIn = true;

        wx.setStorageSync('loginState', {
          openid: res.result.data.openid,
          loggedIn: true,
          timestamp: Date.now()
        });

        return wx.cloud.callFunction({
          name: 'getUserProfile',
          data: {}
        });
      } else {
        throw new Error(res.result.msg || '登录失败');
      }
    }).then(profileRes => {
      if (profileRes && profileRes.result.code === 0) {
        app.globalData.coupons = profileRes.result.data.coupons || 0;
      }
      wx.switchTab({ url: '/pages/home/home' });
    }).catch(err => {
      console.error('登录失败:', err);
      wx.showToast({ title: err.message || '登录失败，请重试', icon: 'none' });
      this.setData({ logging: false });
    });
  },

  skipLogin: function () {
    app.globalData.openid = '';
    app.globalData.loggedIn = false;
    wx.setStorageSync('loginState', {
      openid: '',
      loggedIn: false,
      timestamp: Date.now()
    });
    wx.switchTab({ url: '/pages/home/home' });
  }
});
