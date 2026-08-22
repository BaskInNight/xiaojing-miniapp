const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const { orderId } = event;

  console.log('[getOrderById] 查询订单详情', { openid, orderId });

  if (!orderId) {
    return { code: 400, msg: '缺少订单ID', data: null };
  }

  try {
    // 同时支持 _id 和 id 字段查询
    let orderRes = await db.collection('orders')
      .where({ _id: orderId, _openid: openid })
      .get();

    if (orderRes.data.length === 0) {
      orderRes = await db.collection('orders')
        .where({ id: orderId, _openid: openid })
        .get();
    }

    if (orderRes.data.length === 0) {
      return { code: 404, msg: '订单不存在', data: null };
    }

    const order = orderRes.data[0];

    return {
      code: 0,
      msg: 'ok',
      data: { order }
    };
  } catch (err) {
    console.error('[getOrderById] 查询异常', err);
    return { code: 500, msg: '查询订单失败: ' + err.message, data: null };
  }
};
