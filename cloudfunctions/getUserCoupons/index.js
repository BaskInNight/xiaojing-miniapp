const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  console.log('[getUserCoupons] 查询用户优惠券', { openid });

  try {
    const now = new Date();

    // 查询未使用的、未过期的优惠券
    const couponRes = await db.collection('user_coupons')
      .where({
        _openid: openid,
        status: 'unused',
        expireAt: db.command.gt(now)
      })
      .orderBy('createdAt', 'desc')
      .get();

    // 批量加载模板名称（避免 N+1 查询）
    const templateIds = [...new Set(couponRes.data.map(c => c.templateId).filter(Boolean))];
    const templateMap = {};
    if (templateIds.length > 0) {
      // 云数据库最多一次查询 100 条，模板数量通常远低于此
      const batchSize = 100;
      for (let i = 0; i < templateIds.length; i += batchSize) {
        const batch = templateIds.slice(i, i + batchSize);
        const tmplRes = await db.collection('coupon_templates')
          .where({ _id: db.command.in(batch) })
          .get();
        tmplRes.data.forEach(t => {
          templateMap[t._id] = t.name || '优惠券';
        });
      }
    }

    const coupons = couponRes.data.map(c => ({
      id: c._id,
      name: templateMap[c.templateId] || '优惠券',
      value: c.value || 1,
      source: c.source || 'unknown',
      expireAt: c.expireAt,
      createdAt: c.createdAt
    }));

    // 同时返回已使用和已过期的数量（方便展示）
    const usedCountRes = await db.collection('user_coupons')
      .where({ _openid: openid, status: 'used' })
      .count();
    const expiredCountRes = await db.collection('user_coupons')
      .where({ _openid: openid, status: 'expired' })
      .count();

    return {
      code: 0,
      msg: 'ok',
      data: {
        coupons,
        totalUnused: coupons.length,
        totalUsed: usedCountRes.total,
        totalExpired: expiredCountRes.total
      }
    };
  } catch (err) {
    console.error('[getUserCoupons] 查询异常', err);
    return { code: 500, msg: '服务器内部错误: ' + err.message, data: null };
  }
};
