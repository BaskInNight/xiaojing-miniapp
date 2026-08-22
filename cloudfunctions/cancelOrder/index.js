const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const { orderId } = event;

  console.log('[cancelOrder] 取消订单', { openid, orderId });

  if (!orderId) {
    return { code: 400, msg: '缺少订单ID', data: null };
  }

  try {
    // 验证订单归属
    const orderRes = await db.collection('orders')
      .where({ _id: orderId, _openid: openid })
      .get();

    if (orderRes.data.length === 0) {
      return { code: 404, msg: '订单不存在', data: null };
    }

    const order = orderRes.data[0];

    // 已取消的订单不可重复取消
    if (order.status === '已取消') {
      return { code: 1004, msg: '订单已取消，无需重复操作', data: null };
    }

    // 返还优惠券（先于取消订单执行，失败则中止取消）
    let returnedCoupon = false;
    if (order.couponId) {
      try {
        const updateRes = await db.collection('user_coupons').doc(order.couponId).update({
          data: {
            status: 'unused',
            usedAt: null,
            orderId: ''
          }
        });
        if (updateRes.stats.updated > 0) {
          returnedCoupon = true;
          console.log('[cancelOrder] 优惠券已返还', { couponId: order.couponId });
        }
      } catch (e) {
        console.warn('[cancelOrder] 返还优惠券失败', e);
        return { code: 1005, msg: '优惠券返还失败，取消操作已中止', data: null };
      }
    }

    // 更新订单状态
    await db.collection('orders').doc(orderId).update({
      data: { status: '已取消', cancelledAt: db.serverDate() }
    });

    console.log('[cancelOrder] 取消成功', { orderId });

    return {
      code: 0,
      msg: 'ok',
      data: {
        orderId,
        returnedCoupon
      }
    };
  } catch (err) {
    console.error('[cancelOrder] 取消失败', err);
    return { code: 500, msg: '取消失败: ' + err.message, data: null };
  }
};
