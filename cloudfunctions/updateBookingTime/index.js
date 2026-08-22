const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  const { orderId, bookingDate, bookingTime } = event;

  console.log('[updateBookingTime] 修改预约时间', { openid, orderId, bookingDate, bookingTime });

  if (!orderId || !bookingDate || !bookingTime) {
    return { code: 400, msg: '参数缺失', data: null };
  }

  try {
    // 验证订单归属
    const orderRes = await db.collection('orders').doc(orderId).get();
    if (!orderRes.data) {
      return { code: 404, msg: '订单不存在', data: null };
    }

    if (orderRes.data._openid !== openid) {
      return { code: 403, msg: '无权操作此订单', data: null };
    }

    if (orderRes.data.status !== '已预约' && orderRes.data.status !== '预热中') {
      return { code: 400, msg: '当前状态不允许修改时间', data: null };
    }

    // 计算新的预计完成时间
    const totalTime = orderRes.data.totalTime || 30;
    const startDateTime = new Date(`${bookingDate}T${bookingTime}:00`);
    const endDateTime = new Date(startDateTime.getTime() + totalTime * 60 * 1000);
    const endTime = `${endDateTime.getFullYear()}-${String(endDateTime.getMonth() + 1).padStart(2, '0')}-${String(endDateTime.getDate()).padStart(2, '0')} ${String(endDateTime.getHours()).padStart(2, '0')}:${String(endDateTime.getMinutes()).padStart(2, '0')}`;

    // 更新订单
    await db.collection('orders').doc(orderId).update({
      data: {
        bookingDate,
        bookingTime,
        startTime: `${bookingDate} ${bookingTime}`,
        endTime,
        status: orderRes.data.status === '预热中' ? '已预约' : '已预约',
        updatedAt: db.serverDate()
      }
    });

    console.log('[updateBookingTime] 修改成功', { orderId, bookingDate, bookingTime });

    return {
      code: 0,
      msg: 'ok',
      data: {
        bookingDate,
        bookingTime,
        startTime: `${bookingDate} ${bookingTime}`,
        endTime
      }
    };
  } catch (err) {
    console.error('[updateBookingTime] 修改异常', err);
    return { code: 500, msg: '修改失败: ' + err.message, data: null };
  }
};
