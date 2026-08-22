const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const TRANSITIONS = {
  '已预约': ['进行中', '启动待确认', '启动失败', '已取消'],
  '待启动': ['进行中', '启动待确认', '启动失败', '已取消'],
  '启动待确认': ['进行中', '启动失败', '已取消'],
  '进行中': ['已完成', '故障', '已取消'],
  '启动失败': ['待启动', '进行中', '启动待确认', '已取消']
};

exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID;
  const orderId = typeof event.orderId === 'string' ? event.orderId.trim() : '';
  const nextStatus = typeof event.status === 'string' ? event.status.trim() : '';

  if (!orderId || !nextStatus) {
    return { code: 400, msg: '缺少订单ID或状态', data: null };
  }

  try {
    const result = await db.collection('orders')
      .where({ _id: orderId, _openid: openid })
      .limit(1)
      .get();
    if (result.data.length === 0) {
      return { code: 404, msg: '订单不存在', data: null };
    }

    const order = result.data[0];
    const current = order.status || '';
    if (current === nextStatus) {
      return {
        code: 0,
        msg: 'ok',
        data: { orderId, status: nextStatus, idempotent: true }
      };
    }

    const allowed = TRANSITIONS[current] || [];
    if (!allowed.includes(nextStatus)) {
      return {
        code: 409,
        msg: `非法状态转换: ${current} -> ${nextStatus}`,
        data: null
      };
    }

    const updateData = {
      status: nextStatus,
      updatedAt: db.serverDate()
    };
    if (Number.isInteger(event.programId) && event.programId > 0) {
      updateData.programId = event.programId;
    }
    if (event.errorCode) updateData.lastStartError = String(event.errorCode);
    if (nextStatus === '进行中') updateData.startedAt = db.serverDate();
    if (nextStatus === '已完成') updateData.completedAt = db.serverDate();

    await db.collection('orders').doc(orderId).update({ data: updateData });

    if (order.deviceId) {
      const deviceStatus = nextStatus === '进行中'
        ? 'working'
        : (nextStatus === '已完成' || nextStatus === '启动失败'
          ? 'online'
          : '');
      if (deviceStatus) {
        try {
          await db.collection('devices').where({ bleName: order.deviceId }).update({
            data: {
              status: deviceStatus,
              lastStatusUpdate: db.serverDate()
            }
          });
        } catch (deviceError) {
          console.warn('[updateOrderRuntimeStatus] device status sync failed',
            deviceError);
        }
      }
    }

    return {
      code: 0,
      msg: 'ok',
      data: { orderId, status: nextStatus, idempotent: false }
    };
  } catch (error) {
    console.error('[updateOrderRuntimeStatus] failed', error);
    return { code: 500, msg: '订单状态更新失败: ' + error.message, data: null };
  }
};
