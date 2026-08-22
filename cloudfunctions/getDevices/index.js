const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async () => {
  console.log('[getDevices] 查询设备列表');

  try {
    const result = await db.collection('devices').limit(100).get();

    const devices = result.data.map(d => ({
      id: d._id,
      name: d.name || '',
      bleName: d.bleName || '',
      location: d.location || '',
      status: d.status || 'offline',
      fault: !!d.fault,
      faultReason: d.faultReason || '',
      lastStatusUpdate: d.lastStatusUpdate || null
    }));

    return {
      code: 0,
      msg: 'ok',
      data: { devices }
    };
  } catch (err) {
    console.error('[getDevices] 查询异常', err);
    return { code: 500, msg: '查询设备失败: ' + err.message, data: null };
  }
};
