const app = getApp();
const helper = require('../../utils/helper.js');

Page({
  data: {
    currentTab: '',
    tabs: [
      { key: '', label: '全部' },
      { key: 'active', label: '进行中' },
      { key: '已完成', label: '已完成' },
      { key: '已取消', label: '已取消' }
    ],
    orders: [],
    page: 1,
    pageSize: 20,
    hasMore: true,
    loading: false,
    loadingMore: false
  },

  onShow: function () {
    this.setData({ page: 1, hasMore: true });
    this.loadOrders(true);
  },

  switchTab: function (e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ currentTab: tab, orders: [], page: 1, hasMore: true });
    this.loadOrders(true);
  },

  loadOrders: function (refresh = false) {
    if (this.data.loading) return;
    if (!refresh && !this.data.hasMore) return;

    this.setData(refresh ? { loading: true } : { loadingMore: true });

    wx.cloud.callFunction({
      name: 'getUserOrders',
      data: {
        status: this.data.currentTab,
        page: this.data.page,
        pageSize: this.data.pageSize
      }
    }).then(res => {
      if (res.result.code !== 0) {
        wx.showToast({ title: res.result.msg || '加载失败', icon: 'none' });
        return;
      }

      const data = res.result.data;
      const orders = refresh
        ? data.orders
        : this.data.orders.concat(data.orders);

      this.setData({
        orders,
        hasMore: data.hasMore,
        loading: false,
        loadingMore: false
      });
    }).catch(err => {
      console.error('加载订单失败:', err);
      wx.showToast({ title: '网络错误', icon: 'none' });
      this.setData({ loading: false, loadingMore: false });
    });
  },

  onReachBottom: function () {
    if (this.data.hasMore && !this.data.loadingMore) {
      this.setData({ page: this.data.page + 1 });
      this.loadOrders(false);
    }
  },

  onPullDownRefresh: function () {
    this.setData({ page: 1, hasMore: true });
    this.loadOrders(true);
    wx.stopPullDownRefresh();
  },

  goDetail: function (e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/orderDetail/orderDetail?orderId=${id}` });
  },

  cancelOrder: function (e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '取消订单',
      content: '确定要取消此订单吗？',
      confirmColor: '#FF5252',
      success: (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '取消中...' });
          wx.cloud.callFunction({
            name: 'cancelOrder',
            data: { orderId: id }
          }).then(res => {
            wx.hideLoading();
            if (res.result.code === 0) {
              wx.showToast({ title: '已取消', icon: 'success' });
              this.loadOrders(true);
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

  rebook: function (e) {
    const order = e.currentTarget.dataset.order;
    const deviceId = order.bleDeviceId || order.deviceId || '';
    const deviceName = order.deviceName || order.deviceId || '';
    wx.navigateTo({
      url: `/pages/wash/wash?deviceId=${encodeURIComponent(deviceId)}&deviceName=${encodeURIComponent(deviceName)}`
    });
  },

  deleteOrder: function (e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除记录',
      content: '确定要删除此订单记录吗？',
      confirmColor: '#FF5252',
      success: (res) => {
        if (res.confirm) {
          wx.cloud.callFunction({
            name: 'cancelOrder',
            data: { orderId: id }
          }).then(res => {
            if (res.result.code === 0) {
              wx.showToast({ title: '已删除', icon: 'success' });
            } else {
              wx.showToast({ title: res.result.msg || '删除失败', icon: 'none' });
            }
            this.loadOrders(true);
          }).catch(() => {
            wx.showToast({ title: '网络错误', icon: 'none' });
            this.loadOrders(true);
          });
        }
      }
    });
  },

  formatTime: function (dateStr) {
    return helper.formatShortTime(dateStr);
  },

  goHome: function () {
    wx.switchTab({ url: '/pages/home/home' });
  },

  getPackageLabel: function (pkg) {
    return pkg === 'dry' ? '烘干清洗' : '无烘干快洗';
  }
});
