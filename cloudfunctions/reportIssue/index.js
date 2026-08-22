const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const { type, deviceId, description, phone } = event;

  console.log('[reportIssue] 提交报修', { openid, type, description: description?.slice(0, 30) });

  // 后端校验
  if (!description || description.trim().length === 0) {
    return { code: 400, msg: '请填写问题描述', data: null };
  }

  if (phone && !/^1\d{10}$/.test(phone)) {
    return { code: 400, msg: '请输入正确的手机号', data: null };
  }

  try {
    const result = await db.collection('issues').add({
      data: {
        _openid: openid,
        type: type || '其他问题',
        deviceId: deviceId || '',
        description: description.trim(),
        phone: phone || '',
        status: '待处理',
        createdAt: db.serverDate()
      }
    });

    console.log('[reportIssue] 提交成功', { issueId: result._id });

    return {
      code: 0,
      msg: 'ok',
      data: { issueId: result._id }
    };
  } catch (err) {
    console.error('[reportIssue] 提交失败', err);
    return { code: 500, msg: '提交失败: ' + err.message, data: null };
  }
};
