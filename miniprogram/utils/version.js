'use strict';

const MINIAPP_VERSION = 'mb-diagprefs-20260809-0200';

/*
 * 正式发布开关：是否在 wash 页面显示“开发测试”折叠区。
 * 生产构建应设为 false 隐藏整个硬件诊断入口。
 * 当前板测版本设为 true。
 */
const MINIAPP_ENABLE_HARDWARE_DIAGNOSTICS = true;

module.exports = {
  MINIAPP_VERSION,
  MINIAPP_ENABLE_HARDWARE_DIAGNOSTICS
};
