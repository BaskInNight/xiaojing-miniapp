/**
 * sendNotification 云函数
 *
 * 发送微信订阅消息通知
 * 使用场景：
 *   - 洗涤完成 → 通知用户取衣
 *   - 预约即将开始 → 提醒用户
 *   - 设备故障 → 通知用户和管理员
 *
 * ============================================================
 *  配置说明：
 *  在微信公众平台（mp.weixin.qq.com）的「功能 → 订阅消息」中
 *  申请模板后，将模板ID替换下方的占位符
 * ============================================================
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// ====== 模板ID配置（需在微信公众平台申请）======
const TEMPLATES = {
  // 洗涤完成通知：设备XXX已完成清洗，请及时取衣
  WASH_COMPLETE: '填写你的洗涤完成模板ID',

  // 预约提醒：您的预约将于XX分钟后开始
  BOOKING_REMINDER: '填写你的预约提醒模板ID',

  // 故障通知：设备XXX出现故障，故障代码XXX
  FAULT_ALERT: '填写你的故障通知模板ID'
};

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  const { type, data } = event;
  console.log('[sendNotification] 发送通知', { openid, type });

  if (!type) {
    return { code: 400, msg: '缺少通知类型', data: null };
  }

  try {
    let result;

    switch (type) {
      case 'washComplete':
        result = await sendWashComplete(openid, data);
        break;
      case 'bookingReminder':
        result = await sendBookingReminder(openid, data);
        break;
      case 'faultAlert':
        result = await sendFaultAlert(openid, data);
        break;
      default:
        return { code: 400, msg: '未知通知类型: ' + type, data: null };
    }

    return {
      code: 0,
      msg: 'ok',
      data: result
    };
  } catch (err) {
    console.error('[sendNotification] 发送失败', err);

    // 订阅消息发送失败不阻塞主流程
    return {
      code: 0,
      msg: '通知发送结果: ' + err.message,
      data: { sent: false, error: err.message }
    };
  }
};

/**
 * 发送洗涤完成通知
 */
async function sendWashComplete(openid, data) {
  if (TEMPLATES.WASH_COMPLETE.startsWith('填写')) {
    console.log('[通知] 洗涤完成模板未配置，跳过');
    return { sent: false, reason: '模板未配置' };
  }

  try {
    const result = await cloud.openapi.subscribeMessage.send({
      touser: openid,
      templateId: TEMPLATES.WASH_COMPLETE,
      data: {
        thing1: { value: data.deviceName || '洗衣机' },
        time2: { value: data.endTime || new Date().toLocaleString() },
        thing3: { value: '请及时取出衣物，关闭机门' }
      },
      page: 'pages/home/home'
    });
    console.log('[通知] 洗涤完成通知已发送', result);
    return { sent: true, msgId: result.msgid };
  } catch (err) {
    console.error('[通知] 洗涤完成通知发送失败', err);
    throw err;
  }
}

/**
 * 发送预约提醒
 */
async function sendBookingReminder(openid, data) {
  if (TEMPLATES.BOOKING_REMINDER.startsWith('填写')) {
    console.log('[通知] 预约提醒模板未配置，跳过');
    return { sent: false, reason: '模板未配置' };
  }

  try {
    const result = await cloud.openapi.subscribeMessage.send({
      touser: openid,
      templateId: TEMPLATES.BOOKING_REMINDER,
      data: {
        thing1: { value: data.deviceName || '洗衣机' },
        time2: { value: data.startTime || '' },
        thing3: { value: '设备即将开始工作，请保持蓝牙连接' }
      },
      page: 'pages/booking/booking'
    });
    console.log('[通知] 预约提醒已发送', result);
    return { sent: true, msgId: result.msgid };
  } catch (err) {
    console.error('[通知] 预约提醒发送失败', err);
    throw err;
  }
}

/**
 * 发送故障通知
 */
async function sendFaultAlert(openid, data) {
  if (TEMPLATES.FAULT_ALERT.startsWith('填写')) {
    console.log('[通知] 故障通知模板未配置，跳过');
    return { sent: false, reason: '模板未配置' };
  }

  try {
    const result = await cloud.openapi.subscribeMessage.send({
      touser: openid,
      templateId: TEMPLATES.FAULT_ALERT,
      data: {
        thing1: { value: data.deviceName || '洗衣机' },
        thing2: { value: data.faultReason || '设备异常' },
        time3: { value: new Date().toLocaleString() }
      },
      page: 'pages/repair/repair'
    });
    console.log('[通知] 故障通知已发送', result);
    return { sent: true, msgId: result.msgid };
  } catch (err) {
    console.error('[通知] 故障通知发送失败', err);
    throw err;
  }
}
