const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const config = require('./config');

// Node.js 内置 crypto 模块（云函数环境可用）
const crypto = require('crypto');

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const { orderId, totalFee, body } = event;

  console.log('[createPayment] 创建支付', { openid, orderId, totalFee });

  try {
    if (!orderId || totalFee === undefined) {
      return { code: 400, msg: '参数缺失：orderId, totalFee', data: null };
    }

    // 生成商户订单号（使用时间戳+随机数避免重复）
    const outTradeNo = 'JJ' + Date.now() + Math.random().toString(36).slice(2, 8).toUpperCase();

    // ========== 开发模式：模拟支付 ==========
    if (config.devMode) {
      console.log('[createPayment] 开发模式，模拟支付成功', { orderId, outTradeNo });

      // 模拟成功，返回假数据
      const mockPay = {
        timeStamp: Math.floor(Date.now() / 1000).toString(),
        nonceStr: Math.random().toString(36).slice(2),
        package: 'prepay_id=mock_' + orderId,
        signType: 'MD5',
        paySign: 'mock_sign',
        outTradeNo,
        isMock: true
      };

      return {
        code: 0,
        msg: 'ok',
        data: mockPay
      };
    }

    // ========== 生产模式：调微信支付API ==========
    if (!config.mchId || !config.apiKey) {
      return { code: 500, msg: '支付未配置：请填写商户号信息', data: null };
    }

    const nonceStr = Math.random().toString(36).slice(2);
    const timeStamp = Math.floor(Date.now() / 1000).toString();
    const ip = wxContext.CLIENTIP || '127.0.0.1';

    // 构建支付参数
    const params = {
      appid: config.appId,
      mch_id: config.mchId,
      nonce_str: nonceStr,
      body: body || '净界同频-洗涤服务',
      out_trade_no: outTradeNo,
      total_fee: Math.round(totalFee * 100), // 元转分
      spbill_create_ip: ip,
      notify_url: config.notifyUrl,
      trade_type: 'JSAPI',
      openid: openid
    };

    // 生成签名
    const sign = getSign(params, config.apiKey);
    params.sign = sign;

    // 调微信支付统一下单API
    const xmlData = buildXML(params);
    const response = await cloud.httpclient.request('https://api.mch.weixin.qq.com/pay/unifiedorder', {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml' },
      data: xmlData,
      dataType: 'text',
      timeout: 10000
    });

    const result = parseXML(response.data || '');

    if (result.return_code === 'SUCCESS' && result.result_code === 'SUCCESS') {
      // 生成前端调起支付所需的签名
      const payParams = {
        appId: config.appId,
        timeStamp: timeStamp,
        nonceStr: nonceStr,
        package: 'prepay_id=' + result.prepay_id,
        signType: 'MD5'
      };
      payParams.paySign = getSign(payParams, config.apiKey);

      return {
        code: 0,
        msg: 'ok',
        data: {
          ...payParams,
          outTradeNo,
          isMock: false
        }
      };
    } else {
      console.error('[createPayment] 微信支付下单失败', result);
      return { code: 500, msg: result.err_code_des || '支付下单失败', data: null };
    }

  } catch (err) {
    console.error('[createPayment] 支付异常', err);
    return { code: 500, msg: '支付异常: ' + err.message, data: null };
  }
};

// ===== 工具函数 =====

// 生成微信支付签名（MD5）
function getSign(params, key) {
  const keys = Object.keys(params).sort();
  const str = keys
    .filter(k => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .map(k => `${k}=${params[k]}`)
    .join('&') + `&key=${key}`;
  return crypto.createHash('md5').update(str, 'utf8').digest('hex').toUpperCase();
}

// 构建XML
function buildXML(params) {
  let xml = '<xml>';
  Object.keys(params).forEach(k => {
    xml += `<${k}><![CDATA[${params[k]}]]></${k}>`;
  });
  xml += '</xml>';
  return xml;
}

// 解析XML（简单解析，只解析微信支付返回的一层结构）
function parseXML(xml) {
  const result = {};
  const regex = /<(\w+)><!\[CDATA\[(.*?)\]\]><\/\1>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    result[match[1]] = match[2];
  }
  // 也解析非CDATA的字段
  const regex2 = /<(\w+)>(\d+?)<\/\1>/g;
  while ((match = regex2.exec(xml)) !== null) {
    result[match[1]] = match[2];
  }
  return result;
}
