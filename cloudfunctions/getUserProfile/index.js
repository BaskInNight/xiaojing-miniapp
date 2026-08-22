const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  console.log('[getUserProfile] 查询用户信息', { openid });

  try {
    const userRes = await db.collection('users').where({ _openid: openid }).get();
    const user = userRes.data.length > 0 ? userRes.data[0] : {};
    const coupons = user.coupons || 0;

    // 统计未使用优惠券数量（从 user_coupons 查询）
    const now = new Date();
    const unusedCouponRes = await db.collection('user_coupons')
      .where({ _openid: openid, status: 'unused', expireAt: db.command.gt(now) })
      .count();

    const orderCountRes = await db.collection('orders')
      .where({ _openid: openid })
      .count();

    // 分页累计总消费，避免默认 100 条限制
    let totalSpend = 0;
    let offset = 0;
    const pageSize = 100;
    let hasMore = true;
    while (hasMore) {
      const pageRes = await db.collection('orders')
        .where({ _openid: openid, status: '已完成' })
        .skip(offset)
        .limit(pageSize)
        .get();
      totalSpend += pageRes.data.reduce((sum, o) => sum + (o.finalPrice || 0), 0);
      hasMore = pageRes.data.length === pageSize;
      offset += pageSize;
    }

    return {
      code: 0,
      msg: 'ok',
      data: {
        coupons: unusedCouponRes.total,
        totalOrders: orderCountRes.total,
        totalSpend,
        nickName: user.nickName || '用户',
        avatarUrl: user.avatarUrl || ''
      }
    };
  } catch (err) {
    console.error('[getUserProfile] 查询异常', err);
    return { code: 500, msg: '查询用户信息失败: ' + err.message, data: null };
  }
};
