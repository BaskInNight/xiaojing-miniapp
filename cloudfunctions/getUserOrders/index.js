const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const { status = '', page = 1, pageSize = 20 } = event;

  console.log('[getUserOrders] 查询订单', { openid, status, page });

  try {
    const condition = { _openid: openid };
    if (status === 'active') {
      condition.status = db.command.in([
        '已预约', '待启动', '启动待确认', '进行中'
      ]);
    } else if (status) {
      condition.status = status;
    }

    const countRes = await db.collection('orders').where(condition).count();
    const total = countRes.total;

    const res = await db.collection('orders')
      .where(condition)
      .orderBy('createdAt', 'desc')
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get();

    const orders = res.data.map(o => ({
      _id: o._id,
      id: o._id,
      clientRequestId: o.clientRequestId || '',
      deviceId: o.deviceId || '',
      deviceName: o.deviceName || '',
      package: o.package || '',
      totalTime: o.totalTime || 0,
      totalPrice: o.totalPrice || 0,
      finalPrice: o.finalPrice || 0,
      couponId: o.couponId || '',
      useCoupon: !!o.couponId,
      status: o.status || '',
      programId: o.programId || 0,
      type: o.type || 'immediate',
      isBooking: !!o.isBooking,
      bookingDate: o.bookingDate || '',
      bookingTime: o.bookingTime || '',
      startTime: o.startTime || '',
      endTime: o.endTime || '',
      createdAt: o.createdAt || '',
      steps: o.steps || {}
    }));

    return {
      code: 0,
      msg: 'ok',
      data: {
        orders,
        total,
        page,
        pageSize,
        hasMore: page * pageSize < total
      }
    };
  } catch (err) {
    console.error('[getUserOrders] 查询异常', err);
    return { code: 500, msg: '查询订单失败: ' + err.message, data: null };
  }
};
