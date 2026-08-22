const app = getApp();
const helper = require('../../utils/helper.js');

Page({
  data: {
    order: null,
    loading: true,
    steps: []
  },

  onLoad: function (options) {
    if (options.orderId) {
      this.loadOrderDetail(options.orderId);
    } else {
      wx.showToast({ title: '参数错误', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1500);
    }
  },

  loadOrderDetail: function (orderId) {
    this.setData({ loading: true });

    wx.cloud.callFunction({
      name: 'getOrderById',
      data: { orderId }
    }).then(res => {
      if (res.result.code === 0) {
        this.setOrderData(res.result.data.order);
      } else {
        wx.showToast({ title: res.result.msg || '订单不存在', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 1500);
      }
    }).catch(err => {
      console.error('加载订单详情失败:', err);
      wx.showToast({ title: '加载失败', icon: 'none' });
    }).finally(() => {
      this.setData({ loading: false });
    });
  },

  setOrderData: function (order) {
    const stepNames = {
      soak: { label: '浸泡', emoji: '💧', unit: '次' },
      wash: { label: '搓洗', emoji: '🧼', unit: '轮' },
      rinse: { label: '漂洗', emoji: '💦', unit: '轮' },
      dry: { label: '烘干', emoji: '💨', unit: '轮' }
    };

    const steps = [];
    if (order.steps) {
      Object.keys(stepNames).forEach(key => {
        if (order.steps[key] && order.steps[key].enabled) {
          steps.push({
            ...stepNames[key],
            count: order.steps[key].count,
            time: order.steps[key].count * order.steps[key].time
          });
        }
      });
    }

    this.setData({ order, steps });
  },

  cancelOrder: function () {
    const order = this.data.order;
    wx.showModal({
      title: '取消订单',
      content: '确定要取消此订单吗？',
      confirmColor: '#FF5252',
      success: (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '取消中...' });
          wx.cloud.callFunction({
            name: 'cancelOrder',
            data: { orderId: order._id }
          }).then(res => {
            wx.hideLoading();
            if (res.result.code === 0) {
              wx.showToast({ title: '已取消', icon: 'success' });
              this.loadOrderDetail(order._id);
            } else {
              wx.showToast({ title: res.result.msg || '取消失败', icon: 'none' });
            }
          }).catch(() => {
            wx.hideLoading();
            wx.showToast({ title: '网络错误', icon: 'none' });
          });
        }
      }
    });
  },

  rebook: function () {
    const order = this.data.order;
    const deviceId = order.bleDeviceId || order.deviceId || '';
    const deviceName = order.deviceName || order.deviceId || '';
    wx.navigateTo({
      url: `/pages/wash/wash?deviceId=${encodeURIComponent(deviceId)}&deviceName=${encodeURIComponent(deviceName)}`
    });
  },

  goBack: function () {
    wx.navigateBack();
  },

  formatTime: function (dateStr) {
    return helper.formatFullTime(dateStr);
  },

  getPackageLabel: function (pkg) {
    return pkg === 'dry' ? '烘干清洗' : '无烘干快洗';
  }
});
