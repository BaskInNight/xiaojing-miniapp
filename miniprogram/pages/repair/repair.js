Page({
  data: {
    issueTypes: ['设备故障', '清洗不干净', '设备噪音大', '支付问题', '其他问题'],
    selectedType: 0,
    deviceId: '',
    description: '',
    phone: ''
  },

  onTypeChange: function (e) {
    this.setData({ selectedType: parseInt(e.detail.value) });
  },

  onDeviceIdInput: function (e) {
    this.setData({ deviceId: e.detail.value });
  },

  onDescInput: function (e) {
    this.setData({ description: e.detail.value });
  },

  onPhoneInput: function (e) {
    this.setData({ phone: e.detail.value });
  },

  submitIssue: function () {
    if (!this.data.description) {
      wx.showToast({ title: '请填写问题描述', icon: 'none' });
      return;
    }

    if (this.data.phone && !/^1\d{10}$/.test(this.data.phone)) {
      wx.showToast({ title: '请输入正确的手机号', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '提交中...' });

    wx.cloud.callFunction({
      name: 'reportIssue',
      data: {
        type: this.data.issueTypes[this.data.selectedType],
        deviceId: this.data.deviceId,
        description: this.data.description,
        phone: this.data.phone
      }
    }).then(res => {
      wx.hideLoading();
      if (res.result.code === 0) {
        wx.showToast({ title: '提交成功，我们会尽快处理', icon: 'success' });

        // 请求订阅消息，以便后续通知维修进度
        wx.requestSubscribeMessage({
          tmplIds: ['填写你的故障通知模板ID'],
          success: (subRes) => {
            console.log('[订阅] 故障通知订阅结果:', subRes);
          },
          fail: () => {}
        });

        // 通知运营方（非阻塞）
        wx.cloud.callFunction({
          name: 'sendNotification',
          data: {
            type: 'faultAlert',
            data: {
              deviceName: this.data.deviceId || '未知设备',
              faultReason: this.data.issueTypes[this.data.selectedType] + ': ' + this.data.description
            }
          }
        }).catch(() => {});

        setTimeout(() => { wx.navigateBack(); }, 1500);
      } else {
        wx.showToast({ title: res.result.msg || '提交失败', icon: 'none' });
      }
    }).catch(() => {
      wx.hideLoading();
      wx.showToast({ title: '网络错误', icon: 'none' });
    });
  },

  callService: function () {
    wx.makePhoneCall({
      phoneNumber: '027-12345678'
    });
  }
});