const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const clientRequestId = typeof event.clientRequestId === 'string'
    ? event.clientRequestId.trim().slice(0, 80)
    : '';

  console.log('[createOrder] 开始下单', {
    openid,
    deviceId: event.deviceId,
    package: event.package,
    clientRequestId
  });

  try {
    // Client retries (including BLE ACK timeout retries) must reuse the same
    // cloud order instead of charging/creating another order.
    if (clientRequestId) {
      const existing = await db.collection('orders')
        .where({ _openid: openid, clientRequestId })
        .limit(1)
        .get();
      if (existing.data.length > 0) {
        const order = existing.data[0];
        return {
          code: 0,
          msg: 'ok',
          data: {
            orderId: order._id,
            orderNo: order._id,
            reused: true,
            status: order.status || ''
          }
        };
      }
    }

    // 1. 检查设备是否故障
    if (event.deviceId) {
      const deviceRes = await db.collection('devices').where({ bleName: event.deviceId }).get();
      if (deviceRes.data.length > 0 && deviceRes.data[0].fault) {
        console.warn('[createOrder] 设备已故障，禁止下单', { deviceId: event.deviceId });
        return { code: 1003, msg: '设备当前故障，无法下单', data: null };
      }
    }

    // 3. 创建订单（先于优惠券核销，避免订单失败时优惠券丢失）
    const orderData = {
      _openid: openid,
      clientRequestId,
      deviceId: event.deviceId || '',
      deviceName: event.deviceName || '',
      package: event.package || '',
      steps: event.steps || {},
      totalTime: event.totalTime || 0,
      totalPrice: event.totalPrice || 0,
      finalPrice: event.finalPrice || 0,
      paid: true,
      useCoupon: !!event.couponId,
      couponId: event.couponId || '',
      type: event.isBooking ? 'booking' : 'immediate',
      status: event.isBooking ? '已预约' : '待启动',
      isBooking: !!event.isBooking,
      bookingDate: event.bookingDate || '',
      bookingTime: event.bookingTime || '',
      startTime: event.startTime || '立即',
      endTime: event.endTime || '',
      createdAt: db.serverDate()
    };

    const orderResult = await db.collection('orders').add({ data: orderData });
    const orderId = orderResult._id;

    // 4. 优惠券核销（订单创建成功后执行）
    let usedCouponValue = 0;
    if (event.couponId) {
      const couponRes = await db.collection('user_coupons')
        .where({ _id: event.couponId, _openid: openid, status: 'unused' })
        .get();

      if (couponRes.data.length === 0) {
        // 优惠券无效，订单已创建但不使用优惠券
        console.warn('[createOrder] 优惠券无效或已使用，订单继续', { couponId: event.couponId });
      } else {
        const coupon = couponRes.data[0];

        if (coupon.expireAt && new Date(coupon.expireAt) < new Date()) {
          console.warn('[createOrder] 优惠券已过期，订单继续', { couponId: event.couponId });
        } else {
          usedCouponValue = coupon.value || 0;
          await db.collection('user_coupons').doc(event.couponId).update({
            data: {
              status: 'used',
              usedAt: db.serverDate(),
              orderId: orderId
            }
          });
        }
      }
    }

    // 5. 回写优惠券信息到订单
    if (event.couponId && usedCouponValue > 0) {
      await db.collection('orders').doc(orderId).update({
        data: { usedCouponValue: usedCouponValue }
      });
    }

    console.log('[createOrder] 下单成功', { orderId, openid });

    return {
      code: 0,
      msg: 'ok',
      data: {
        orderId,
        orderNo: orderId,
        reused: false,
        status: orderData.status,
        usedCoupon: !!event.couponId,
        usedCouponValue
      }
    };
  } catch (err) {
    console.error('[createOrder] 下单异常', err);
    return { code: 500, msg: '服务器内部错误: ' + err.message, data: null };
  }
};
