/**
 * 初始化管理员账号
 * 在云开发控制台 → 云函数 中右键点击该函数 → 本地调试 即可运行
 * 或在云函数代码中取消注释 exports.main 下方的直接调用。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const bcrypt = require('bcryptjs');

exports.main = async (event) => {
  const { username, password } = event;
  if (!username || !password || password.length < 12) {
    return { code: 400, msg: '必须显式提供用户名和至少 12 位密码' };
  }

  // 检查是否已存在
  const exist = await db.collection('admins').where({ username }).get();
  if (exist.data.length > 0) {
    return { code: 0, msg: `管理员 ${username} 已存在，无需重复创建` };
  }

  const salt = bcrypt.genSaltSync(10);
  const passwordHash = bcrypt.hashSync(password, salt);

  const res = await db.collection('admins').add({
    data: {
      username,
      passwordHash,
      createdAt: db.serverDate()
    }
  });

  return { code: 0, msg: `管理员 ${username} 创建成功`, data: { id: res._id } };
};
