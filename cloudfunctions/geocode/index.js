/**
 * 逆地址解析云函数
 *
 * 功能：将 GPS 坐标（lat, lng）转为文字地址
 * 使用：腾讯地图 WebService API → 逆地址解析
 *
 * 使用前需要：
 *   1. 前往 https://lbs.qq.com/ 注册账号
 *   2. 创建应用 → 获取 Key（选择 WebService API）
 *   3. 将 key 填入下方 TENCENT_MAP_KEY
 *
 * API 文档：
 *   https://lbs.qq.com/service/webService/webServiceGuide/webServiceGcoder
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const config = require('./config');
const TENCENT_MAP_KEY = config.TENCENT_MAP_KEY;

const https = require('https');

/**
 * 使用 Node.js https 模块发送 GET 请求
 */
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('解析响应失败: ' + data.slice(0, 200)));
        }
      });
    }).on('error', reject);
  });
}

exports.main = async (event) => {
  const { latitude, longitude } = event;

  if (!latitude || !longitude) {
    return { code: 400, msg: '缺少坐标参数', data: null };
  }

  // 清理超过24小时的旧缓存（概率执行，约5%概率触发）
  try {
    if (Math.random() < 0.05) {
      const db = cloud.database();
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const expired = await db.collection('location_cache')
        .where({ createTime: db.command.lt(cutoff) })
        .limit(500)
        .get();
      if (expired.data.length > 0) {
        const ids = expired.data.map(d => d._id);
        for (const id of ids) {
          await db.collection('location_cache').doc(id).remove();
        }
        console.log('[geocode] 已清理过期缓存', { count: ids.length });
      }
    }
  } catch (e) {
    // 清理失败不影响主流程
  }

  // 1. 尝试从缓存读取（1分钟内同一位置不重复请求）
  try {
    const db = cloud.database();
    const now = Date.now();
    const cache = await db.collection('location_cache')
      .where({
        lat: cloud.database().command.lte(latitude + 0.005)
              .and(cloud.database().command.gte(latitude - 0.005)),
        lng: cloud.database().command.lte(longitude + 0.005)
              .and(cloud.database().command.gte(longitude - 0.005))
      })
      .orderBy('createTime', 'desc')
      .limit(1)
      .get();

    if (cache.data.length > 0) {
      const cached = cache.data[0];
      const age = now - new Date(cached.createTime).getTime();
      if (age < 60000) {
        return {
          code: 0,
          msg: 'ok',
          data: { address: cached.address, fromCache: true }
        };
      }
    }
  } catch (e) {
    // 集合不存在，忽略
  }

  // 2. 调用腾讯地图 API
  try {
    const apiUrl = `https://apis.map.qq.com/ws/geocoder/v1/?key=${TENCENT_MAP_KEY}&location=${latitude},${longitude}&get_poi=1`;
    const res = await httpsGet(apiUrl);

    if (res.status !== 0) {
      return {
        code: 0,
        msg: '逆地址解析失败，显示坐标',
        data: { address: `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`, fromCache: false }
      };
    }

    const result = res.result;
    let address = result.address;

    // 添加附近地标方便识别
    const pois = (result.pois || []).slice(0, 2);
    if (pois.length > 0) {
      const names = pois.map(p => p.title).join('、');
      address += `（${names}附近）`;
    }

    // 3. 写入缓存
    try {
      const db = cloud.database();
      await db.collection('location_cache').add({
        data: {
          lat: latitude,
          lng: longitude,
          address: address,
          createTime: cloud.database().serverDate()
        }
      });
    } catch (e) { /* 缓存写入失败不阻塞 */ }

    return {
      code: 0,
      msg: 'ok',
      data: { address, fromCache: false }
    };

  } catch (err) {
    return {
      code: 0,
      msg: err.message,
      data: { address: `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`, fromCache: false }
    };
  }
};
