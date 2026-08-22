const JWT_SECRET = process.env.JWT_SECRET || '';
if (!JWT_SECRET) {
  throw new Error('Missing required cloud function environment variable: JWT_SECRET');
}

const ADMIN_ACCOUNTS = [];
if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
  ADMIN_ACCOUNTS.push({
    username: process.env.ADMIN_USERNAME,
    password: process.env.ADMIN_PASSWORD
  });
}

module.exports = {
  JWT_SECRET,
  JWT_EXPIRES_IN: '24h',
  ADMIN_ACCOUNTS
};
