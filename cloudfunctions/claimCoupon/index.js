const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const { templateId } = event;

  console.log('[claimCoupon] 领券请求', { openid, templateId });

  try {
    // 1. 校验优惠券模板
    let finalTemplateId = templateId;
    if (!finalTemplateId) {
      // 未指定模板ID，使用默认的洗涤优惠券模板
      const defaultTmpl = await db.collection('coupon_templates')
        .where({ type: 'wash_discount', isActive: true })
        .limit(1)
        .get();
      if (defaultTmpl.data.length === 0) {
        return { code: 404, msg: '无可用优惠券模板', data: null };
      }
      finalTemplateId = defaultTmpl.data[0]._id;
    }

    const templateRes = await db.collection('coupon_templates').doc(finalTemplateId).get();
    if (!templateRes.data) {
      return { code: 404, msg: '优惠券模板不存在', data: null };
    }
    const template = templateRes.data;

    if (!template.isActive) {
      return { code: 1003, msg: '该优惠券已停用', data: null };
    }

    // 2. 检查每日限领逻辑（跨天重置）
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

    const todayCountRes = await db.collection('user_coupons')
      .where({
        _openid: openid,
        source: 'ad',
        createdAt: db.command.and([
          db.command.gte(todayStart),
          db.command.lt(todayEnd)
        ])
      })
      .count();

    if (todayCountRes.total >= 1) {
      console.warn('[claimCoupon] 今日已领过', { openid, count: todayCountRes.total });
      return { code: 1001, msg: '今日已领取过，明天再来吧', data: null };
    }

    // 3. 计算过期时间
    const expireAt = new Date(now.getTime() + (template.validDays || 30) * 24 * 60 * 60 * 1000);

    // 4. 二次检查：再次确认今日未领过（竞态防护）
    const recheckRes = await db.collection('user_coupons')
      .where({
        _openid: openid,
        source: 'ad',
        createdAt: db.command.and([
          db.command.gte(todayStart),
          db.command.lt(todayEnd)
        ])
      })
      .count();
    if (recheckRes.total >= 1) {
      console.warn('[claimCoupon] 二次检查：今日已领过，拒绝重复领取');
      return { code: 1001, msg: '今日已领取过，明天再来吧', data: null };
    }

    // 5. 创建优惠券
    const couponResult = await db.collection('user_coupons').add({
      data: {
        _openid: openid,
        templateId: finalTemplateId,
        value: template.value || 1,
        status: 'unused',
        source: 'ad',
        expireAt: expireAt,
        createdAt: db.serverDate(),
        usedAt: null,
        orderId: ''
      }
    });

    console.log('[claimCoupon] 领券成功', { openid, couponId: couponResult._id });

    return {
      code: 0,
      msg: 'ok',
      data: {
        couponId: couponResult._id,
        value: template.value,
        name: template.name,
        expireAt: expireAt.toISOString()
      }
    };
  } catch (err) {
    console.error('[claimCoupon] 领券异常', err);
    return { code: 500, msg: '服务器内部错误: ' + err.message, data: null };
  }
};
