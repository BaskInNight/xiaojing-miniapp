/**
 * 管理后台 HTTP 云函数
 *
 * 通过 action 参数分发路由，统一返回格式 { code, msg, data }
 * 所有接口（除 login 外）需要 Authorization: Bearer <token>
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const XLSX = require('xlsx');

const { JWT_SECRET, JWT_EXPIRES_IN, ADMIN_ACCOUNTS } = require('./config');

// ============================================================
// 工具函数
// ============================================================

function success(data = null) {
  return { code: 0, msg: 'ok', data };
}

function fail(code, msg) {
  return { code, msg, data: null };
}

function getToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// 生成 JWT
function createToken(username) {
  return jwt.sign({ username, role: 'admin' }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

// 统一返回格式的包裹函数（用于 CORS 响应）
function wrap(res) {
  return {
    code: res.code !== undefined ? res.code : 0,
    msg: res.msg || 'ok',
    data: res.data !== undefined ? res.data : null
  };
}

// ============================================================
// 路由处理
// ============================================================

const handlers = {

  // --------------------------------------------------
  // admin.login — 管理员登录
  // --------------------------------------------------
  async 'admin.login'(event) {
    const { username, password } = event;
    if (!username || !password) return fail(400, '请输入账号和密码');

    // 从 admins 集合查找
    const adminRes = await db.collection('admins')
      .where({ username }).get();

    let valid = false;
    if (adminRes.data.length > 0) {
      const admin = adminRes.data[0];
      valid = await bcrypt.compare(password, admin.passwordHash);
    } else {
      // 首次部署：用 config.js 中的默认账号
      const defaultAdmin = ADMIN_ACCOUNTS.find(a => a.username === username);
      if (defaultAdmin) {
        valid = password === defaultAdmin.password;
      }
    }

    if (!valid) return fail(401, '账号或密码错误');

    const token = createToken(username);
    return success({ token, username });
  },

  // --------------------------------------------------
  // admin.dashboard — 仪表盘统计
  // --------------------------------------------------
  async 'admin.dashboard'() {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

    const todayOrders = await db.collection('orders')
      .where({ createdAt: _.gte(todayStart).lt(todayEnd) })
      .count();

    const todayRevenueRes = await db.collection('orders')
      .where({
        createdAt: _.gte(todayStart).lt(todayEnd),
        status: _.neq('已取消')
      })
      .get();
    const todayRevenue = todayRevenueRes.data.reduce((s, o) => s + (o.finalPrice || 0), 0);

    const newUsers = await db.collection('users')
      .where({ createdAt: _.gte(todayStart).lt(todayEnd) })
      .count();

    const deviceTotal = await db.collection('devices').count();
    const activeThreshold = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const activeDevices = await db.collection('devices')
      .where({ lastStatusUpdate: _.gte(activeThreshold) })
      .count();

    return success({
      todayOrders: todayOrders.total,
      todayRevenue,
      newUsers: newUsers.total,
      deviceActiveRate: deviceTotal.total > 0
        ? Math.round((activeDevices.total / deviceTotal.total) * 100)
        : 0
    });
  },

  // --------------------------------------------------
  // admin.order.list — 订单列表
  // --------------------------------------------------
  async 'admin.order.list'(event) {
    const { page = 1, pageSize = 20, status, deviceId, startDate, endDate } = event;
    const condition = {};

    if (status) condition.status = status;
    if (deviceId) condition.deviceId = { $regex: deviceId };
    if (startDate || endDate) {
      condition.createdAt = {};
      if (startDate) condition.createdAt.$gte = new Date(startDate);
      if (endDate) condition.createdAt.$lt = new Date(endDate);
    }

    const totalRes = await db.collection('orders').where(condition).count();
    const orderRes = await db.collection('orders')
      .where(condition)
      .orderBy('createdAt', 'desc')
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get();

    return success({
      orders: orderRes.data,
      total: totalRes.total,
      page,
      pageSize,
      hasMore: (page - 1) * pageSize + orderRes.data.length < totalRes.total
    });
  },

  // --------------------------------------------------
  // admin.order.detail — 订单详情
  // --------------------------------------------------
  async 'admin.order.detail'(event) {
    const { orderId } = event;
    if (!orderId) return fail(400, '缺少订单ID');

    const res = await db.collection('orders').doc(orderId).get();
    if (!res.data) return fail(404, '订单不存在');

    return success({ order: res.data });
  },

  // --------------------------------------------------
  // admin.order.export — 导出订单 Excel
  // --------------------------------------------------
  async 'admin.order.export'(event) {
    const { status, startDate, endDate } = event;
    const condition = {};
    if (status) condition.status = status;
    if (startDate || endDate) {
      condition.createdAt = {};
      if (startDate) condition.createdAt.$gte = new Date(startDate);
      if (endDate) condition.createdAt.$lt = new Date(endDate);
    }

    const allRes = await db.collection('orders')
      .where(condition)
      .orderBy('createdAt', 'desc')
      .get();

    const rows = allRes.data.map(o => ({
      '订单号': o._id,
      '设备': o.deviceName || '',
      '用户': o._openid || '',
      '套餐': o.package === 'quick' ? '快洗' : o.package === 'dry' ? '烘干' : o.package || '',
      '金额': o.finalPrice || 0,
      '状态': o.status || '',
      '创建时间': o.createdAt ? new Date(o.createdAt).toLocaleString() : ''
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, '订单');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    return success({
      base64: buf.toString('base64'),
      fileName: `orders_${Date.now()}.xlsx`
    });
  },

  // --------------------------------------------------
  // admin.device.list — 设备列表
  // --------------------------------------------------
  async 'admin.device.list'(event) {
    const { page = 1, pageSize = 50 } = event;
    const totalRes = await db.collection('devices').count();
    const deviceRes = await db.collection('devices')
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get();

    return success({
      devices: deviceRes.data,
      total: totalRes.total,
      page,
      pageSize
    });
  },

  // --------------------------------------------------
  // admin.device.update — 编辑设备
  // --------------------------------------------------
  async 'admin.device.update'(event) {
    const { deviceId, name, bleName, location, status, fault, faultReason } = event;
    if (!deviceId) return fail(400, '缺少设备ID');

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (bleName !== undefined) updateData.bleName = bleName;
    if (location !== undefined) updateData.location = location;
    if (status !== undefined) updateData.status = status;
    if (fault !== undefined) updateData.fault = fault;
    if (faultReason !== undefined) updateData.faultReason = faultReason;
    updateData.lastStatusUpdate = db.serverDate();

    await db.collection('devices').doc(deviceId).update({ data: updateData });
    return success({ deviceId });
  },

  // --------------------------------------------------
  // admin.user.list — 用户列表
  // --------------------------------------------------
  async 'admin.user.list'(event) {
    const { page = 1, pageSize = 20, keyword } = event;
    const condition = {};
    if (keyword) {
      condition.$or = [
        { nickName: { $regex: keyword } },
        { _openid: { $regex: keyword } }
      ];
    }

    const totalRes = await db.collection('users').where(condition).count();
    const userRes = await db.collection('users')
      .where(condition)
      .orderBy('lastLoginAt', 'desc')
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get();

    // 批量查询每个用户的订单数和优惠券数
    const userIds = userRes.data.map(u => u._openid);
    const users = [];
    for (const u of userRes.data) {
      const orderCount = await db.collection('orders')
        .where({ _openid: u._openid }).count();
      users.push({
        _openid: u._openid,
        nickName: u.nickName || '',
        avatarUrl: u.avatarUrl || '',
        totalOrders: orderCount.total,
        lastLoginAt: u.lastLoginAt || ''
      });
    }

    return success({
      users,
      total: totalRes.total,
      page,
      pageSize
    });
  },

  // --------------------------------------------------
  // admin.repair.list — 报修工单
  // --------------------------------------------------
  async 'admin.repair.list'(event) {
    const { page = 1, pageSize = 20, deviceId } = event;
    const condition = {};
    if (deviceId) condition.deviceId = deviceId;

    const totalRes = await db.collection('issues').where(condition).count();
    const issueRes = await db.collection('issues')
      .where(condition)
      .orderBy('status', 'asc')  // 未处理(status='待处理') 排前面
      .orderBy('createdAt', 'desc')
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get();

    return success({
      repairs: issueRes.data,
      total: totalRes.total,
      page,
      pageSize
    });
  },

  // --------------------------------------------------
  // admin.repair.update — 处理工单
  // --------------------------------------------------
  async 'admin.repair.update'(event) {
    const { issueId, status, remark } = event;
    if (!issueId) return fail(400, '缺少工单ID');

    const updateData = { status: status || '已完成' };
    if (remark) updateData.remark = remark;
    updateData.handledAt = db.serverDate();

    await db.collection('issues').doc(issueId).update({ data: updateData });
    return success({ issueId });
  },

  // --------------------------------------------------
  // admin.coupon.templates — 优惠券模板列表
  // --------------------------------------------------
  async 'admin.coupon.templates'() {
    const res = await db.collection('coupon_templates').get();
    return success({ templates: res.data });
  },

  // --------------------------------------------------
  // admin.coupon.stats — 优惠券统计
  // --------------------------------------------------
  async 'admin.coupon.stats'() {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // 今日广告发放量
    const adToday = await db.collection('user_coupons')
      .where({
        source: 'ad',
        createdAt: _.gte(todayStart).lt(new Date(todayStart.getTime() + 86400000))
      })
      .count();

    // 总核销量
    const usedTotal = await db.collection('user_coupons')
      .where({ status: 'used' })
      .count();

    // 总发放量
    const totalIssued = await db.collection('user_coupons').count();

    return success({
      adToday: adToday.total,
      usedTotal: usedTotal.total,
      totalIssued: totalIssued.total
    });
  },

  // --------------------------------------------------
  // admin.coupon.issue — 手动发放优惠券
  // --------------------------------------------------
  async 'admin.coupon.issue'(event) {
    const { openid, templateId, count = 1 } = event;
    if (!openid || !templateId) return fail(400, '缺少用户或模板');

    const templateRes = await db.collection('coupon_templates').doc(templateId).get();
    if (!templateRes.data) return fail(404, '模板不存在');

    const template = templateRes.data;
    const expireAt = new Date(Date.now() + (template.validDays || 30) * 86400000);
    const now = db.serverDate();

    const ids = [];
    for (let i = 0; i < count; i++) {
      const res = await db.collection('user_coupons').add({
        data: {
          _openid: openid,
          templateId,
          value: template.value || 1,
          status: 'unused',
          source: 'manual',
          expireAt,
          createdAt: now,
          usedAt: null,
          orderId: ''
        }
      });
      ids.push(res._id);
    }

    return success({ couponIds: ids, count });
  },

  // --------------------------------------------------
  // admin.coupon.list — 优惠券发放记录
  // --------------------------------------------------
  async 'admin.coupon.list'(event) {
    const { page = 1, pageSize = 20, status, keyword } = event;
    const condition = {};
    if (status) condition.status = status;

    // 有关键词则先查用户，再过滤
    if (keyword) {
      const userRes = await db.collection('users')
        .where({
          $or: [
            { nickName: { $regex: keyword } },
            { _openid: { $regex: keyword } }
          ]
        })
        .get();
      const openids = userRes.data.map(u => u._openid);
      if (openids.length === 0) {
        return success({ coupons: [], total: 0, page, pageSize });
      }
      condition._openid = _.in(openids);
    }

    const totalRes = await db.collection('user_coupons').where(condition).count();
    const couponRes = await db.collection('user_coupons')
      .where(condition)
      .orderBy('createdAt', 'desc')
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get();

    // 批量查询用户昵称
    const openidList = [...new Set(couponRes.data.map(c => c._openid).filter(Boolean))];
    const userMap = {};
    if (openidList.length > 0) {
      const usersRes = await db.collection('users')
        .where({ _openid: _.in(openidList) })
        .get();
      usersRes.data.forEach(u => { userMap[u._openid] = u.nickName || ''; });
    }

    // 批量查询模板名称
    const tmplIds = [...new Set(couponRes.data.map(c => c.templateId).filter(Boolean))];
    const tmplMap = {};
    if (tmplIds.length > 0) {
      const tmplRes = await db.collection('coupon_templates')
        .where({ _id: _.in(tmplIds) })
        .get();
      tmplRes.data.forEach(t => { tmplMap[t._id] = t.name || ''; });
    }

    const coupons = couponRes.data.map(c => ({
      _id: c._id,
      _openid: c._openid,
      nickName: userMap[c._openid] || '-',
      templateName: tmplMap[c.templateId] || '-',
      value: c.value,
      status: c.status,
      source: c.source,
      expireAt: c.expireAt,
      usedAt: c.usedAt,
      orderId: c.orderId,
      createdAt: c.createdAt
    }));

    return success({ coupons, total: totalRes.total, page, pageSize });
  },

  // --------------------------------------------------
  // admin.coupon.template.add — 新增模板
  // --------------------------------------------------
  async 'admin.coupon.template.add'(event) {
    const { name, type, value, validDays, description } = event;
    if (!name) return fail(400, '请输入模板名称');

    const res = await db.collection('coupon_templates').add({
      data: {
        name,
        type: type || 'wash_discount',
        value: value || 1,
        validDays: validDays || 30,
        description: description || '',
        isActive: true,
        createdAt: db.serverDate()
      }
    });

    return success({ templateId: res._id });
  },

  // --------------------------------------------------
  // admin.coupon.template.update — 编辑模板
  // --------------------------------------------------
  async 'admin.coupon.template.update'(event) {
    const { templateId, name, type, value, validDays, description } = event;
    if (!templateId) return fail(400, '缺少模板ID');

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (type !== undefined) updateData.type = type;
    if (value !== undefined) updateData.value = value;
    if (validDays !== undefined) updateData.validDays = validDays;
    if (description !== undefined) updateData.description = description;

    await db.collection('coupon_templates').doc(templateId).update({ data: updateData });
    return success({ templateId });
  },

  // --------------------------------------------------
  // admin.coupon.template.toggle — 启用/停用
  // --------------------------------------------------
  async 'admin.coupon.template.toggle'(event) {
    const { templateId, isActive } = event;
    if (!templateId) return fail(400, '缺少模板ID');

    await db.collection('coupon_templates').doc(templateId).update({
      data: { isActive: !!isActive }
    });
    return success({ templateId, isActive: !!isActive });
  }
};

// ============================================================
// 入口
// ============================================================

exports.main = async (event, context) => {
  // 打印收到的 event 结构（用于调试）
  console.log('[admin] event keys:', Object.keys(event), 'bodyType:', typeof event.body);

  // HTTP 触发时 body 是 JSON 字符串，需要解析后合并到 event
  if (event.body && typeof event.body === 'string') {
    try {
      const parsed = JSON.parse(event.body);
      console.log('[admin] parsed body keys:', Object.keys(parsed));
      event = { ...event, ...parsed };
    } catch (e) {
      console.log('[admin] body parse error:', e.message);
    }
  }

  const { action } = event;
  console.log('[admin] action:', action);

  // CORS 预检
  if (context.request?.method === 'OPTIONS') {
    return {
      code: 0,
      data: null,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization'
      }
    };
  }

  if (!action) return fail(400, '缺少 action 参数');

  const handler = handlers[action];
  if (!handler) return fail(404, `未知操作: ${action}`);

  // Token 校验（login 除外）
  if (action !== 'admin.login') {
    const authHeader = event.headers?.Authorization
      || event.Authorization
      || (event.headers?.authorization)
      || '';
    const token = getToken(authHeader);
    const decoded = verifyToken(token);
    if (!decoded) {
      return {
        code: 401,
        msg: '未授权或登录已过期',
        data: null,
        headers: { 'Access-Control-Allow-Origin': '*' }
      };
    }
  }

  try {
    const result = await handler(event);
    const headers = { 'Access-Control-Allow-Origin': '*' };
    if (typeof result === 'object' && !result.headers) {
      result.headers = headers;
    }
    return result;
  } catch (err) {
    console.error(`[admin] ${action} 异常:`, err.message, err.stack);
    return {
      code: 500,
      msg: '服务器内部错误: ' + err.message,
      data: null,
      headers: { 'Access-Control-Allow-Origin': '*' }
    };
  }
};
