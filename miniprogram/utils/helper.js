/**
 * utils/helper.js - 通用工具函数
 */

/**
 * 格式化日期为 YYYY-MM-DD
 */
function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 格式化为 HH:mm
 */
function formatTime(date) {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * 格式化日期字符串为 MM-DD
 */
function formatExpire(dateStr) {
  if (!dateStr) return '永久';
  const d = new Date(dateStr);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${m}-${day}`;
}

/**
 * 格式化完整时间 YYYY-MM-DD HH:mm
 */
function formatFullTime(dateStr) {
  if (!dateStr) return '--';
  const d = new Date(dateStr);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}`;
}

/**
 * 格式化短时间 MM-DD HH:mm
 */
function formatShortTime(dateStr) {
  if (!dateStr) return '--';
  const d = new Date(dateStr);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${m}-${day} ${h}:${min}`;
}

/**
 * 观看激励视频广告领取优惠券
 * @param {string} adUnitId 广告单元ID
 * @param {function} onClaimed 领券成功后的回调（刷新页面数据）
 */
function watchAdForCoupon(adUnitId, onClaimed) {
  if (!wx.createRewardedVideoAd) {
    wx.showToast({ title: '当前版本不支持', icon: 'none' });
    return;
  }

  const app = getApp();
  const videoAd = wx.createRewardedVideoAd({ adUnitId });

  videoAd.onClose((res) => {
    if (res && res.isEnded) {
      wx.cloud.callFunction({
        name: 'claimCoupon',
        data: { templateId: '' }
      }).then(res => {
        if (res.result.code === 0) {
          if (onClaimed) onClaimed();
          wx.showToast({ title: '获得1张优惠券！', icon: 'success' });
        } else if (res.result.code === 1001) {
          wx.showToast({ title: '今日已领取过', icon: 'none' });
        } else {
          wx.showToast({ title: res.result.msg || '领券失败', icon: 'none' });
        }
      }).catch(() => {
        wx.showToast({ title: '领券失败', icon: 'none' });
      });
    } else {
      wx.showToast({ title: '未完整观看广告', icon: 'none' });
    }
  });

  videoAd.show().catch(() => {
    videoAd.load().then(() => videoAd.show()).catch(err => {
      console.error('广告加载失败:', err);
    });
  });
}

module.exports = {
  formatDate,
  formatTime,
  formatExpire,
  formatFullTime,
  formatShortTime,
  watchAdForCoupon
};
