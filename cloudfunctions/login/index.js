const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const { nickName, avatarUrl } = event;

  console.log('[login] 用户登录', { openid, hasNickName: !!nickName });

  try {
    const now = new Date();
    let isNewUser = false;

    // 查询用户是否存在
    const userRes = await db.collection('users').where({ _openid: openid }).get();

    if (userRes.data.length === 0) {
      // 新用户注册：创建用户
      isNewUser = true;

      // 未设置昵称则自动生成 微信用户+数字
      let finalNickName = nickName;
      if (!finalNickName) {
        const countRes = await db.collection('users').count();
        const userNumber = 1001 + (countRes.total || 0);
        finalNickName = '微信用户' + userNumber;
      }

      const userData = {
        _openid: openid,
        nickName: finalNickName,
        avatarUrl: avatarUrl || '',
        coupons: 2,
        createdAt: db.serverDate(),
        lastLoginAt: db.serverDate()
      };

      const addRes = await db.collection('users').add({ data: userData });
      console.log('[login] 用户创建成功', { openid, userId: addRes._id });

      // 赠送注册优惠券（失败不影响登录）
      try {
        const tmplRes = await db.collection('coupon_templates')
          .where({ type: 'wash_discount', isActive: true })
          .limit(1)
          .get();
        const templateId = tmplRes.data.length > 0 ? tmplRes.data[0]._id : '';
        const expireAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
        for (let i = 0; i < 2; i++) {
          await db.collection('user_coupons').add({
            data: {
              _openid: openid,
              templateId: templateId,
              value: 1,
              status: 'unused',
              source: 'register',
              expireAt: expireAt,
              createdAt: db.serverDate(),
              usedAt: null,
              orderId: ''
            }
          });
        }
        console.log('[login] 注册优惠券赠送完成', { openid });
      } catch (couponErr) {
        console.warn('[login] 赠送优惠券失败（可忽略）', couponErr);
      }
    } else {
      // 已存在用户：更新登录时间
      const updateData = { lastLoginAt: db.serverDate() };
      // 仅当传入了有效昵称且不是自动生成的默认值时更新
      if (nickName && !nickName.startsWith('微信用户')) {
        updateData.nickName = nickName;
      }
      // 仅当传入了有效头像 URL 时更新
      if (avatarUrl && avatarUrl.length > 10) {
        updateData.avatarUrl = avatarUrl;
      }
      await db.collection('users').where({ _openid: openid }).update({ data: updateData });
    }

    return {
      code: 0,
      msg: 'ok',
      data: {
        openid,
        isNewUser
      }
    };
  } catch (err) {
    console.error('[login] 登录异常', err);
    return { code: 500, msg: '登录失败: ' + err.message, data: null };
  }
};
