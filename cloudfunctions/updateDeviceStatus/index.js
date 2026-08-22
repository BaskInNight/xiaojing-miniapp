const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  const { deviceId, status, faultReason } = event;

  console.log('[updateDeviceStatus] 更新设备状态', { openid, deviceId, status });

  if (!deviceId || !status) {
    return { code: 400, msg: '缺少设备ID或状态', data: null };
  }

  const validStatuses = ['online', 'offline', 'working', 'fault'];
  if (!validStatuses.includes(status)) {
    return { code: 400, msg: '无效的设备状态: ' + status, data: null };
  }

  try {
    // 通过 _id 或 bleName 查找设备
    let deviceRes;
    if (deviceId.length >= 16 && /^[a-f0-9]{16,}$/i.test(deviceId)) {
      deviceRes = await db.collection('devices').where({ _id: deviceId }).get();
    }
    if (!deviceRes || deviceRes.data.length === 0) {
      deviceRes = await db.collection('devices').where({ bleName: deviceId }).get();
    }

    if (deviceRes.data.length === 0) {
      console.warn('[updateDeviceStatus] 设备不存在', { deviceId });
      return { code: 404, msg: '设备不存在', data: null };
    }

    const device = deviceRes.data[0];

    const updateData = {
      status: status,
      lastStatusUpdate: db.serverDate()
    };

    if (status === 'fault' && faultReason) {
      updateData.fault = true;
      updateData.faultReason = faultReason;

      // ===== 故障自动创建报修工单 =====
      try {
        const existingIssue = await db.collection('issues').where({
          deviceId: device.bleName || device.name,
          status: '待处理'
        }).get();

        if (existingIssue.data.length === 0) {
          await db.collection('issues').add({
            data: {
              _openid: openid,
              type: '设备故障',
              deviceId: device.bleName || device.name || '',
              description: '设备自动上报故障: ' + (faultReason || '未知故障'),
              phone: '',
              status: '待处理',
              source: 'auto',  // 标记为自动创建
              createdAt: db.serverDate()
            }
          });
          console.log('[updateDeviceStatus] 已自动创建故障工单', { deviceId: device.bleName, faultReason });
        } else {
          console.log('[updateDeviceStatus] 该设备已有待处理的故障工单，跳过');
        }
      } catch (issueErr) {
        console.warn('[updateDeviceStatus] 自动创建工单失败（不阻塞主流程）', issueErr);
      }
    } else if (status === 'online' || status === 'working') {
      updateData.fault = false;
      updateData.faultReason = '';
    }

    await db.collection('devices').doc(device._id).update({ data: updateData });

    console.log('[updateDeviceStatus] 更新成功', { deviceId: device._id, status });

    return {
      code: 0,
      msg: 'ok',
      data: {
        deviceId: device._id,
        name: device.name,
        status: status,
        lastStatusUpdate: new Date().toISOString()
      }
    };
  } catch (err) {
    console.error('[updateDeviceStatus] 更新异常', err);
    return { code: 500, msg: '服务器内部错误: ' + err.message, data: null };
  }
};
