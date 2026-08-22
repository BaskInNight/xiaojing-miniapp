// ===== 微信支付配置 =====
// 生产模式需填写真实商户号信息
module.exports = {
  // 开发模式：true=跳过真实支付（方便调试）
  devMode: true,

  // 微信商户号（devMode=false 时必填）
  mchId: '',

  // 商户API密钥（devMode=false 时必填）
  apiKey: '',

  // 小程序AppID
  appId: 'wxe712a62e3a90faca',

  // 支付通知回调地址（需部署HTTP云函数后填写）
  notifyUrl: '',

  // 订单币种
  feeType: 'CNY'
};
