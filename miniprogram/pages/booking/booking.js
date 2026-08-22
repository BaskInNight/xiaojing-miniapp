const app = getApp();
const helper = require('../../utils/helper.js');

function routeValue(value) {
  if (typeof value !== 'string') return '';
  const out = value.trim();
  return (out === 'undefined' || out === 'null') ? '' : out;
}

Page({
  data: {
    currentTab: 'active',
    allBookings: [],
    displayBookings: [],
    coupons: 0,
    loading: true,

    // 修改预约时间弹窗
    showTimePicker: false,
    editOrderId: '',
    editDeviceName: '',
    newDate: '',
    newTime: '',
    todayDate: '',
    maxDate: '',
    editing: false
  },

  onShow: function () {
    this.stopBookingClock();
    this.loadBookings();
    this.setData({ coupons: app.globalData.coupons || 0 });
    this._bookingTimer = setInterval(() => {
      const updated = this.processBookings(this.data.allBookings);
      this.setData({ allBookings: updated });
      this.filterBookings();
    }, 30000);
  },

  onHide: function () {
    this.stopBookingClock();
  },

  onUnload: function () {
    this.stopBookingClock();
  },

  stopBookingClock: function () {
    if (this._bookingTimer) {
      clearInterval(this._bookingTimer);
      this._bookingTimer = null;
    }
  },

  loadBookings: function () {
    this.setData({ loading: true });

    // 优先从云端加载预约数据
    wx.cloud.callFunction({
      name: 'getUserOrders',
      data: { page: 1, pageSize: 100 }
    }).then(res => {
      if (res.result.code === 0) {
        const orders = res.result.data.orders || [];
        const bookings = this.processBookings(orders);
        this.setData({ allBookings: bookings });
        this.filterBookings();
      } else {
        this.loadLocalBookings();
      }
    }).catch(err => {
      console.error('云端加载预约失败，使用本地缓存:', err);
      this.loadLocalBookings();
    }).finally(() => {
      this.setData({ loading: false });
    });
  },

  loadLocalBookings: function () {
    try {
      const bookings = wx.getStorageSync('washBookings') || [];
      const updatedBookings = this.processBookings(bookings);
      wx.setStorageSync('washBookings', updatedBookings);
      this.setData({ allBookings: updatedBookings });
      this.filterBookings();
    } catch (e) {
      console.error('加载本地预约失败:', e);
    }
  },

  processBookings: function (bookings) {
    const now = new Date();
    return bookings.map(item => {
      if (item.status !== '已预约') {
        return { ...item, isReady: false, countdown: '', progressPercent: 0 };
      }

      if (item.bookingDate && item.bookingTime) {
        const bookingTime = new Date(`${item.bookingDate}T${item.bookingTime}:00`);
        if (Number.isNaN(bookingTime.getTime())) {
          return { ...item, isReady: false, countdown: '', progressPercent: 0 };
        }
        const diffMs = bookingTime.getTime() - now.getTime();

        if (diffMs <= 0) {
          return { ...item, isReady: true, countdown: '', progressPercent: 100 };
        } else {
          const hours = Math.floor(diffMs / (1000 * 60 * 60));
          const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
          const totalWaitMs = 2 * 60 * 60 * 1000;
          const elapsedMs = totalWaitMs - diffMs;
          const progressPercent = Math.max(0, Math.min(100, (elapsedMs / totalWaitMs) * 100));

          return {
            ...item,
            isReady: false,
            countdown: hours > 0 ? `${hours}小时${minutes}分钟` : `${minutes}分钟`,
            progressPercent
          };
        }
      }
      return { ...item, isReady: false, countdown: '', progressPercent: 0 };
    });
  },

  switchTab: function (e) {
    this.setData({ currentTab: e.currentTarget.dataset.tab });
    this.filterBookings();
  },

  filterBookings: function () {
    const { currentTab, allBookings } = this.data;
    let result = [];

    if (currentTab === 'active') {
      result = allBookings.filter(b => b.status === '已预约');
    } else if (currentTab === 'completed') {
      result = allBookings.filter(b => b.status === '已完成');
    } else {
      result = allBookings.filter(b => b.status === '已取消');
    }

    this.setData({ displayBookings: result });
  },

  cancelBooking: function (e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '取消预约',
      content: '确定取消吗？',
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
            } else {
              wx.showToast({ title: res.result.msg || '取消失败', icon: 'none' });
            }
            this.loadBookings();
          }).catch(() => {
            wx.hideLoading();
            wx.showToast({ title: '网络错误', icon: 'none' });
            this.loadBookings();
          });
        }
      }
    });
  },

  startNow: function (e) {
    const booking = e.currentTarget.dataset.booking;
    if (!booking.isReady) {
      wx.showToast({ title: '预约时间未到', icon: 'none' });
      return;
    }
    const connectedDeviceId = app.globalData.bleConnected ?
      routeValue(app.globalData.bleDeviceId) : '';
    const connectedDeviceName = app.globalData.bleConnected ?
      routeValue(app.globalData.bleDeviceName) : '';
    const deviceId = connectedDeviceId || routeValue(booking.bleDeviceId) ||
      routeValue(booking.deviceId);
    const deviceName = connectedDeviceName || routeValue(booking.deviceName) ||
      routeValue(booking.deviceId);
    wx.navigateTo({
      url: `/pages/wash/wash?deviceId=${encodeURIComponent(deviceId)}&deviceName=${encodeURIComponent(deviceName)}&startNow=1&bookingId=${booking._id || booking.id}`
    });
  },

  rebook: function (e) {
    const booking = e.currentTarget.dataset.booking;
    const deviceId = routeValue(booking.bleDeviceId) ||
      routeValue(booking.deviceId);
    const deviceName = routeValue(booking.deviceName) ||
      routeValue(booking.deviceId);
    wx.navigateTo({
      url: `/pages/wash/wash?deviceId=${encodeURIComponent(deviceId)}&deviceName=${encodeURIComponent(deviceName)}`
    });
  },

  deleteBooking: function (e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除记录',
      content: '确定删除吗？',
      confirmColor: '#FF5252',
      success: (res) => {
        if (res.confirm) {
          const bookings = wx.getStorageSync('washBookings') || [];
          wx.setStorageSync('washBookings', bookings.filter(b => b.id !== id));
          this.loadBookings();
          wx.showToast({ title: '已删除', icon: 'success' });
        }
      }
    });
  },

  // ====================== 修改预约时间 ======================

  /**
   * 打开修改时间弹窗
   */
  openTimePicker: function (e) {
    const booking = e.currentTarget.dataset.booking;
    const dateStr = booking.bookingDate || '';
    const timeStr = booking.bookingTime || '08:00';

    const today = new Date();
    const todayStr = this._fmtDate(today);
    const maxDate = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
    const maxDateStr = this._fmtDate(maxDate);

    this.setData({
      showTimePicker: true,
      editOrderId: booking._id || booking.id || '',
      editDeviceName: booking.deviceName || '',
      newDate: dateStr || todayStr,
      newTime: timeStr,
      todayDate: todayStr,
      maxDate: maxDateStr,
      editing: false
    });
  },

  /**
   * 关闭时间选择弹窗
   */
  closeTimePicker: function () {
    this.setData({
      showTimePicker: false,
      editOrderId: '',
      editDeviceName: '',
      newDate: '',
      newTime: ''
    });
  },

  /**
   * 日期变更
   */
  onDateChange: function (e) {
    this.setData({ newDate: e.detail.value });
  },

  /**
   * 时间变更
   */
  onTimeChange: function (e) {
    this.setData({ newTime: e.detail.value });
  },

  /**
   * 确认修改预约时间
   */
  confirmTimeChange: function () {
    const { editOrderId, newDate, newTime } = this.data;

    if (!editOrderId) {
      wx.showToast({ title: '订单异常', icon: 'none' });
      return;
    }

    this.setData({ editing: true });

    wx.cloud.callFunction({
      name: 'updateBookingTime',
      data: {
        orderId: editOrderId,
        bookingDate: newDate,
        bookingTime: newTime
      }
    }).then(res => {
      if (res.result.code === 0) {
        wx.showToast({ title: '预约时间已更新', icon: 'success' });
        this.closeTimePicker();
        this.loadBookings();
      } else {
        wx.showToast({ title: res.result.msg || '修改失败', icon: 'none' });
      }
    }).catch(err => {
      console.error('修改预约时间失败:', err);
      wx.showToast({ title: '网络错误', icon: 'none' });
    }).finally(() => {
      this.setData({ editing: false });
    });
  },

  /** 工具：格式 YYYY-MM-DD */
  _fmtDate: function (date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  },

  /** 空函数（阻止弹窗关闭冒泡） */
  noop: function () {},

  goWash: function () {
    wx.navigateTo({ url: '/pages/wash/wash' });
  },

  watchAd: function () {
    helper.watchAdForCoupon('adunit-xxxxxxxxxxxxxxxx', () => {
      this.loadBookings();
    });
  }
});
