require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');
const cron = require('node-cron');
// const nodemailer = require('nodemailer');  用了resend后不用了
const dns = require('dns');
const { promisify } = require('util');
const path = require('path');
const jwt = require('jsonwebtoken');
const { body, validationResult, param } = require('express-validator');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const QRCode = require('qrcode');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const AlipaySdk = require('alipay-sdk').default;
const AlipayFormData = require('alipay-sdk/lib/form').default;
const bcrypt = require('bcryptjs');
const validator = require('validator');
// 引用resend
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

const resolve4 = promisify(dns.resolve4);
const app = express();
const port = process.env.PORT || 3000;

// ======================== 套餐及奖励配置 ========================
const PLAN_PRICES = {
  '1y': parseInt(process.env.PRICE_1Y) || 9900,
  '2y': parseInt(process.env.PRICE_2Y) || 18800,
  '3y': parseInt(process.env.PRICE_3Y) || 36600
};
const PLAN_DAYS = {
  '1y': parseInt(process.env.DAYS_1Y) || 365,
  '2y': parseInt(process.env.DAYS_2Y) || 730,
  '3y': parseInt(process.env.DAYS_3Y) || 1095
};
const PLAN_REWARDS = {
  '1y': parseInt(process.env.REWARD_1Y) || 19900,
  '2y': parseInt(process.env.REWARD_2Y) || 29900,
  '3y': parseInt(process.env.REWARD_3Y) || 39900
};

const TEST_EMAIL = process.env.TEST_EMAIL || null;
const TEST_CODE = process.env.TEST_CODE || null;

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['http://localhost:3000'],
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  skipSuccessfulRequests: true,
});
app.use('/api/', limiter);

// ======================== 数据库连接池 ========================
const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: process.env.PG_PORT || 5432,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE,
  ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  maxUses: 7500,
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        user_email TEXT NOT NULL,
        name TEXT NOT NULL,
        "cycleDays" INTEGER NOT NULL,
        "warningDays" INTEGER NOT NULL,
        "finalDays" INTEGER NOT NULL,
        "warningEmail" TEXT NOT NULL,
        "finalEmail" TEXT NOT NULL,
        "warningMessage" TEXT,
        "finalMessage" TEXT,
        "lastCheckin" BIGINT NOT NULL,
        created BIGINT NOT NULL,
        "warningSent" INTEGER DEFAULT 0,
        "finalSent" INTEGER DEFAULT 0,
        "warningTriggeredAt" BIGINT,
        "needHumanConfirm" INTEGER DEFAULT 0,
        "contactPhone" TEXT,
        "customerNotified" INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_user_email ON tasks(user_email);
      CREATE INDEX IF NOT EXISTS idx_tasks_lastcheckin ON tasks("lastCheckin");
      CREATE INDEX IF NOT EXISTS idx_tasks_needhumanconfirm ON tasks("needHumanConfirm");
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_authorizations (
        email TEXT PRIMARY KEY,
        auth_code TEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        authorized BOOLEAN DEFAULT FALSE,
        created_at BIGINT NOT NULL,
        status TEXT DEFAULT 'active',
        payment_status TEXT DEFAULT 'unpaid',
        paid_at BIGINT,
        referrer_email TEXT,
        referral_code TEXT,
        commission_balance INTEGER DEFAULT 0,
        total_earned INTEGER DEFAULT 0,
        plan_type VARCHAR(10),
        subscription_expires_at BIGINT
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_verification_codes (
        email TEXT NOT NULL,
        code TEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (email, code)
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS commissions (
        id SERIAL PRIMARY KEY,
        referrer_email TEXT NOT NULL,
        user_email TEXT NOT NULL,
        amount INTEGER NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at BIGINT,
        paid_at BIGINT,
        plan_type VARCHAR(10)
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        order_no VARCHAR(64) UNIQUE NOT NULL,
        user_email VARCHAR(255) NOT NULL,
        amount INTEGER NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        payment_channel VARCHAR(20),
        transaction_id VARCHAR(128),
        paid_at BIGINT,
        expires_at BIGINT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT,
        plan_type VARCHAR(10)
      );
      CREATE INDEX IF NOT EXISTS idx_payments_user_email ON payments(user_email);
      CREATE INDEX IF NOT EXISTS idx_payments_order_no ON payments(order_no);
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role VARCHAR(20) DEFAULT 'admin',
        created_at BIGINT NOT NULL
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS system_notices (
        id SERIAL PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        content TEXT NOT NULL,
        is_deleted BOOLEAN DEFAULT FALSE,
        created_at BIGINT NOT NULL,
        updated_at BIGINT
      );
    `);
    const superExists = await client.query('SELECT id FROM admin_users WHERE username = $1', ['admin']);
    if (superExists.rows.length === 0) {
      const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123', 10);
      await client.query('INSERT INTO admin_users (username, password_hash, role, created_at) VALUES ($1, $2, $3, $4)', ['admin', hash, 'super', Math.floor(Date.now() / 1000)]);
    }
    console.log('✅ 数据库初始化完成');
  } catch (err) {
    console.error('❌ 数据库初始化失败', err);
  } finally {
    client.release();
  }
}
initDB();

// ======================== JWT 配置 ========================
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ JWT_SECRET未设置');
  process.exit(1);
}
function generateAccessToken(email) {
  return jwt.sign({ email }, JWT_SECRET, { expiresIn: '24h' });
}
async function authenticateJWT(req, res, next) {
  const token = req.cookies.access_token;
  if (!token) return res.status(401).json({ error: '未登录' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: '登录过期' });
  }
}

const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || JWT_SECRET + '_admin';
function generateAdminToken(username, role) {
  return jwt.sign({ username, role }, ADMIN_JWT_SECRET, { expiresIn: '8h' });
}
function verifyAdminToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: '未提供管理员令牌' });
  try {
    const decoded = jwt.verify(token, ADMIN_JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: '管理员令牌无效或过期' });
  }
}
function requireSuperAdmin(req, res, next) {
  if (req.admin.role !== 'super') return res.status(403).json({ error: '需要超级管理员权限' });
  next();
}

// ======================== 邮件服务 ========================
// let transporter = null;  ==resend不用
// 发送验证码邮件的核心逻辑
async function sendVerificationCode(email, code) {
    try {
        const { data, error } = await resend.emails.send({
            from:'Mind Insurance <service@mindapp.online>', // 比如 noreply@mail.yourdomain.com
            to: [email],
            subject: '【Mind Insurance】Your Verification Code',
            html: `<p>Your verification code is: <strong>${code}</strong></p><p>This code will expire in 10 minutes.</p>`
        });
        if (error) {
            console.error('Resend 发送失败:', error);
            return false;
        }
        console.log('邮件发送成功:', data);
        return true;
    } catch (err) {
        console.error('邮件发送异常:', err);
        return false;
    }
}

// 应用resend后不用，备注掉
// async function initSMTP() {
//  try {
//    const smtpHost = process.env.SMTP_HOST || 'smtp.qq.com';
//    const smtpPort = parseInt(process.env.SMTP_PORT) || 465;
//    let addresses;
//    try { addresses = await resolve4(smtpHost); } catch(e) {}
//    const smtpIp = addresses?.[0] || smtpHost;
//    transporter = nodemailer.createTransport({
//      host: smtpIp,
//      port: smtpPort,
//      secure: smtpPort === 465,
//      auth: {
//        user: process.env.SMTP_USER,
//        pass: process.env.SMTP_PASS
//      },
//      tls: { rejectUnauthorized: false },
//      connectionTimeout: 15000,
//    });
//    await transporter.verify();
//    console.log(`✅ SMTP 服务器就绪`);
//  } catch (err) {
//    console.error('❌ SMTP 初始化失败，邮件功能不可用', err.message);
//  }
// }
// initSMTP();

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}
function generateReferralCode() {
  return Math.random().toString(36).substring(2, 10).toUpperCase();
}
function generateOrderNo() {
  return `PAY${Date.now()}${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
}

// 定时任务
cron.schedule('0 * * * *', async () => {
  const now = Math.floor(Date.now() / 1000);
  await pool.query('DELETE FROM email_verification_codes WHERE expires_at < $1', [now]);
  await pool.query('UPDATE payments SET status = $1 WHERE expires_at < $2 AND status = $3', ['expired', now, 'pending']);
  console.log('🧹 已清理过期验证码和订单');
}, { timezone: 'Asia/Shanghai' });

cron.schedule('0 5 * * *', async () => {
  console.log(`⏰ 定时任务触发（每天5点）：${new Date().toLocaleString('zh-CN')}`);
  try {
    let offset = 0;
    const limit = 1000;
    let hasMore = true;
    while (hasMore) {
      const { rows: tasks } = await pool.query('SELECT * FROM tasks ORDER BY id LIMIT $1 OFFSET $2', [limit, offset]);
      for (const task of tasks) {
        await checkTask(task);
      }
      offset += limit;
      hasMore = tasks.length === limit;
    }
  } catch (err) {
    console.error('🔴 定时任务执行失败', err);
  }
}, { timezone: 'Asia/Shanghai' });

function computeTaskStatus(task, now = Math.floor(Date.now() / 1000)) {
  const diffSec = now - task.lastCheckin;
  const daysSince = Math.floor(diffSec / (24 * 60 * 60));
  const cycleDays = task.cycleDays;
  const warningDays = task.warningDays;
  const finalDays = task.finalDays;
  if (daysSince <= cycleDays) return 'normal';
  const overdueDays = daysSince - cycleDays;
  if (overdueDays < warningDays) return 'normal';
  if (overdueDays < warningDays + finalDays) return 'warning';
  return 'final';
}

// ======================== 微信支付 ========================
let privateKey = null;
try {
  privateKey = fs.readFileSync(process.env.WECHAT_PRIVATE_KEY_PATH, 'utf8');
  console.log('✅ 微信商户私钥加载成功');
} catch (err) {
  console.error('❌ 微信商户私钥加载失败', err.message);
}
function getNonceStr(length = 32) {
  return crypto.randomBytes(length).toString('hex').substring(0, length);
}
function getTimestamp() {
  return Math.floor(Date.now() / 1000).toString();
}
function signWechatPay(method, url, body, nonceStr, timestamp) {
  const urlObj = new URL(url);
  const pathname = urlObj.pathname + urlObj.search;
  const message = `${method}\n${pathname}\n${timestamp}\n${nonceStr}\n${body}\n`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(message);
  sign.end();
  return sign.sign(privateKey, 'base64');
}
async function createWechatNativeOrder(outTradeNo, amount, description) {
  if (!privateKey) throw new Error('微信私钥未加载');
  const url = 'https://api.mch.weixin.qq.com/v3/pay/transactions/native';
  const body = JSON.stringify({
    appid: process.env.WECHAT_APP_ID,
    mchid: process.env.WECHAT_MCH_ID,
    description,
    out_trade_no: outTradeNo,
    notify_url: process.env.WECHAT_NOTIFY_URL,
    amount: { total: amount, currency: 'CNY' }
  });
  const nonceStr = getNonceStr();
  const timestamp = getTimestamp();
  const signature = signWechatPay('POST', url, body, nonceStr, timestamp);
  const authHeader = `WECHATPAY2-SHA256-RSA2048 mchid="${process.env.WECHAT_MCH_ID}",nonce_str="${nonceStr}",timestamp="${timestamp}",serial_no="${process.env.WECHAT_SERIAL_NO}",signature="${signature}"`;
  try {
    const response = await axios.post(url, body, {
      headers: { 'Content-Type': 'application/json', 'Authorization': authHeader, 'Accept': 'application/json' }
    });
    return response.data.code_url;
  } catch (err) {
    console.error('微信Native下单失败:', err.response?.data || err.message);
    throw new Error('微信Native下单失败');
  }
}
function decryptWechatNotify(resource) {
  const { ciphertext, nonce, associated_data } = resource;
  const key = Buffer.from(process.env.WECHAT_API_V3_KEY, 'utf8');
  const ciphertextBuffer = Buffer.from(ciphertext, 'base64');
  const authTag = ciphertextBuffer.slice(-16);
  const encryptedData = ciphertextBuffer.slice(0, -16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'utf8'));
  decipher.setAuthTag(authTag);
  if (associated_data) {
    decipher.setAAD(Buffer.from(associated_data, 'utf8'));
  }
  const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

// ======================== 支付宝支付 ========================
let alipaySdk = null;
try {
  const alipayPrivateKey = fs.readFileSync(process.env.ALIPAY_PRIVATE_KEY_PATH, 'utf8');
  const alipayPublicKey = fs.readFileSync(process.env.ALIPAY_PUBLIC_KEY_PATH, 'utf8');
  alipaySdk = new AlipaySdk({
    appId: process.env.ALIPAY_APP_ID,
    privateKey: alipayPrivateKey,
    alipayPublicKey: alipayPublicKey,
    signType: 'RSA2',
    gateway: 'https://openapi.alipay.com/gateway.do',
  });
  console.log('✅ 支付宝 SDK 初始化成功');
} catch (err) {
  console.error('❌ 支付宝 SDK 初始化失败', err.message);
}
function isMobileDevice(req) {
  const userAgent = req.headers['user-agent'] || '';
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Windows Phone|Mobile/i.test(userAgent);
}

// ======================== 支付成功处理 ========================
async function handlePaymentSuccess(orderNo, transactionId, paidAtUnix, channel) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderCheck = await client.query('SELECT status FROM payments WHERE order_no = $1 FOR UPDATE', [orderNo]);
    if (orderCheck.rows.length === 0) throw new Error('订单不存在');
    if (orderCheck.rows[0].status !== 'pending') {
      console.log(`订单 ${orderNo} 已处理过，跳过`);
      await client.query('COMMIT');
      return true;
    }

    const orderRes = await client.query('SELECT user_email, amount, plan_type FROM payments WHERE order_no = $1', [orderNo]);
    const { user_email, amount, plan_type } = orderRes.rows[0];

    await client.query(`UPDATE payments SET status = 'paid', transaction_id = $1, paid_at = $2, updated_at = $2, payment_channel = $3 WHERE order_no = $4`, [transactionId, paidAtUnix, channel, orderNo]);

    const daysToAdd = PLAN_DAYS[plan_type] || 365;

    const authRes = await client.query('SELECT * FROM email_authorizations WHERE email = $1', [user_email]);
    if (authRes.rows.length === 0) {
      const authCode = generateCode();
      const codeExpires = paidAtUnix + 86400;
      const referralCode = generateReferralCode();
      await client.query(
        `INSERT INTO email_authorizations 
         (email, auth_code, expires_at, authorized, created_at, status, payment_status, paid_at, referral_code, plan_type, subscription_expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [user_email, authCode, codeExpires, true, paidAtUnix, 'active', 'paid', paidAtUnix, referralCode, plan_type, paidAtUnix + daysToAdd * 86400]
      );
    } else {
      const existing = authRes.rows[0];
      const currentExpiration = existing.subscription_expires_at || paidAtUnix;
      const baseTime = Math.max(currentExpiration, paidAtUnix);
      const updatedExpiration = baseTime + daysToAdd * 86400;
      await client.query(
        `UPDATE email_authorizations 
         SET authorized = true, payment_status = 'paid', paid_at = $1, plan_type = $2, subscription_expires_at = $3, status = 'active'
         WHERE email = $4`,
        [paidAtUnix, plan_type, updatedExpiration, user_email]
      );
    }

    // 推荐奖励（首次购买才发放）
    const referrerRes = await client.query('SELECT referrer_email FROM email_authorizations WHERE email = $1', [user_email]);
    let referrerEmail = referrerRes.rows[0]?.referrer_email;
    if (referrerEmail && TEST_EMAIL && referrerEmail === TEST_EMAIL) {
      console.log(`🔧 忽略测试邮箱 ${TEST_EMAIL} 的推荐奖励`);
      referrerEmail = null;
    }
    const existingPaid = await client.query(
      'SELECT id FROM payments WHERE user_email = $1 AND status = $2 AND order_no != $3 LIMIT 1',
      [user_email, 'paid', orderNo]
    );
    const isFirstPurchase = existingPaid.rows.length === 0;
    if (referrerEmail && isFirstPurchase) {
      const rewardAmount = PLAN_REWARDS[plan_type] || 0;
      if (rewardAmount > 0) {
        await client.query(
          `INSERT INTO commissions (referrer_email, user_email, amount, status, created_at, plan_type)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [referrerEmail, user_email, rewardAmount, 'pending', paidAtUnix, plan_type]
        );
        await client.query(
          `UPDATE email_authorizations SET commission_balance = commission_balance + $1, total_earned = total_earned + $1 WHERE email = $2`,
          [rewardAmount, referrerEmail]
        );
        const rewardYuan = (rewardAmount / 100).toFixed(2);
        await sendVerificationCode({
          to: referrerEmail,
          subject: '返利通知',
          text: `您推荐的用户 ${user_email} 购买了 ${plan_type} 套餐，您将获得 ${rewardYuan} 元返利。`
        });
      }
    } else if (referrerEmail && !isFirstPurchase) {
      console.log(`📌 用户 ${user_email} 已是老用户，不发放推荐奖励`);
    }

    const loginCode = generateCode();
    const codeExpires = paidAtUnix + 600;
    await client.query(`INSERT INTO email_verification_codes (email, code, expires_at, created_at) VALUES ($1, $2, $3, $4)`, [user_email, loginCode, codeExpires, paidAtUnix]);
    const amountYuan = (amount / 100).toFixed(2);
    await sendVerificationCode({
      to: user_email,
      subject: '支付成功，验证码',
      text: `您已成功支付${amountYuan}元，购买套餐 ${plan_type}。验证码：${loginCode}，有效期10分钟。`
    });

    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('支付处理失败:', err);
    return false;
  } finally { client.release(); }
}

// ======================== API 路由 ========================
app.get('/api/config', (req, res) => {
  const plans = [
    { id: '1y', name: '1年套餐', price: PLAN_PRICES['1y'], price_yuan: (PLAN_PRICES['1y']/100).toFixed(2), days: PLAN_DAYS['1y'], reward: PLAN_REWARDS['1y'], reward_yuan: (PLAN_REWARDS['1y']/100).toFixed(2) },
    { id: '2y', name: '2年套餐', price: PLAN_PRICES['2y'], price_yuan: (PLAN_PRICES['2y']/100).toFixed(2), days: PLAN_DAYS['2y'], reward: PLAN_REWARDS['2y'], reward_yuan: (PLAN_REWARDS['2y']/100).toFixed(2) },
    { id: '3y', name: '3年套餐', price: PLAN_PRICES['3y'], price_yuan: (PLAN_PRICES['3y']/100).toFixed(2), days: PLAN_DAYS['3y'], reward: PLAN_REWARDS['3y'], reward_yuan: (PLAN_REWARDS['3y']/100).toFixed(2) }
  ];
  res.json({ plans });
});

// 新增：查询邮箱是否有有效订阅
app.post('/api/check-subscription', async (req, res) => {
  const { email } = req.body;
  if (!email || !validator.isEmail(email)) {
    return res.status(400).json({ error: '邮箱无效' });
  }
  try {
    const result = await pool.query(
      'SELECT payment_status, subscription_expires_at FROM email_authorizations WHERE email = $1',
      [email]
    );
    const now = Math.floor(Date.now() / 1000);
    let hasActive = false;
    if (result.rows.length > 0 && result.rows[0].payment_status === 'paid') {
      const expiresAt = result.rows[0].subscription_expires_at;
      if (expiresAt && expiresAt > now) {
        hasActive = true;
      }
    }
    res.json({ hasActiveSubscription: hasActive });
  } catch (err) {
    res.status(500).json({ error: '查询失败' });
  }
});

async function optionalAuth(req, res, next) {
  const token = req.cookies.access_token;
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
    } catch(e) { /* 忽略无效token */ }
  }
  next();
}

app.post('/api/create-wechat-order', optionalAuth, async (req, res) => {
  const { email, orderNo, plan } = req.body;
  if (!email) return res.status(400).json({ error: '缺少邮箱参数' });
  if (!plan || !PLAN_PRICES[plan]) return res.status(400).json({ error: '无效套餐' });
  if (req.user && req.user.email !== email) {
    return res.status(403).json({ error: '邮箱与登录账号不匹配' });
  }
  const amount = PLAN_PRICES[plan];
  const now = Math.floor(Date.now() / 1000);
  try {
    let targetOrderNo = orderNo;
    if (!targetOrderNo) {
      targetOrderNo = generateOrderNo();
      const expires = now + 1800;
      await pool.query(
        `INSERT INTO payments (order_no, user_email, amount, status, expires_at, created_at, payment_channel, plan_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [targetOrderNo, email, amount, 'pending', expires, now, 'wechat', plan]
      );
    } else {
      await pool.query(`UPDATE payments SET plan_type = $1, amount = $2 WHERE order_no = $3`, [plan, amount, targetOrderNo]);
    }

    // 微信支付统一使用Native二维码（PC和移动都显示二维码）
    const codeUrl = await createWechatNativeOrder(targetOrderNo, amount, `心灵保险-${plan}套餐`);
    const qrBase64 = await QRCode.toDataURL(codeUrl);
    res.json({ orderNo: targetOrderNo, qrCode: qrBase64 });
  } catch (err) {
    console.error('微信下单失败:', err);
    res.status(500).json({ error: '微信下单失败' });
  }
});

// 支付宝下单（统一返回URL，PC/移动均支持）
app.post('/api/create-alipay-order', optionalAuth, async (req, res) => {
  const { email, plan } = req.body;
  if (!email) return res.status(400).json({ error: '缺少邮箱参数' });
  if (!plan || !PLAN_PRICES[plan]) return res.status(400).json({ error: '无效套餐' });
  if (req.user && req.user.email !== email) {
    return res.status(403).json({ error: '邮箱与登录账号不匹配' });
  }
  const amount = PLAN_PRICES[plan];
  const now = Math.floor(Date.now() / 1000);
  try {
    let orderRes = await pool.query(`SELECT order_no FROM payments WHERE user_email = $1 AND status = 'pending' AND expires_at > $2 ORDER BY created_at DESC LIMIT 1`, [email, now]);
    let orderNo;
    if (orderRes.rows.length === 0) {
      orderNo = generateOrderNo();
      const expires = now + 1800;
      await pool.query(
        `INSERT INTO payments (order_no, user_email, amount, status, expires_at, created_at, payment_channel, plan_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [orderNo, email, amount, 'pending', expires, now, 'alipay', plan]
      );
    } else {
      orderNo = orderRes.rows[0].order_no;
      await pool.query(`UPDATE payments SET plan_type = $1, amount = $2 WHERE order_no = $3`, [plan, amount, orderNo]);
    }
    const returnUrl = `${process.env.BASE_URL}/?pay_result=success&orderNo=${orderNo}`;
    const notifyUrl = process.env.ALIPAY_NOTIFY_URL;
    const isMobile = isMobileDevice(req);
    
    // 使用 AlipayFormData 生成统一 URL（PC/移动都能直接跳转）
    const formData = new AlipayFormData();
    formData.setMethod('get');
    const method = isMobile ? 'alipay.trade.wap.pay' : 'alipay.trade.page.pay';
    const productCode = isMobile ? 'QUICK_WAP_PAY' : 'FAST_INSTANT_TRADE_PAY';
    formData.addField('bizContent', {
      out_trade_no: orderNo,
      product_code: productCode,
      total_amount: (amount / 100).toFixed(2),
      subject: `心灵保险-${plan}套餐`,
    });
    formData.addField('return_url', returnUrl);
    formData.addField('notify_url', notifyUrl);
    
    const payUrl = await alipaySdk.exec(method, {}, { formData });
    res.json({ payUrl });
  } catch (err) {
    console.error('支付宝下单失败:', err);
    res.status(500).json({ error: '支付宝下单失败' });
  }
});

app.post('/api/pay/alipay/notify', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const params = req.body;
    const verify = await alipaySdk.checkNotifySign(params);
    if (!verify) {
      console.error('支付宝回调验签失败');
      return res.status(400).send('fail');
    }
    if (params.trade_status === 'TRADE_SUCCESS' || params.trade_status === 'TRADE_FINISHED') {
      const outTradeNo = params.out_trade_no;
      const transactionId = params.trade_no;
      const paidAt = Math.floor(Date.parse(params.gmt_payment) / 1000);
      await handlePaymentSuccess(outTradeNo, transactionId, paidAt, 'alipay');
    }
    res.send('success');
  } catch (err) {
    console.error('支付宝回调处理失败:', err);
    res.status(500).send('fail');
  }
});

app.post('/api/pay/wechat/notify', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const { resource } = req.body;
    if (!resource) throw new Error('无效回调');
    const decrypted = decryptWechatNotify(resource);
    const { out_trade_no, transaction_id, success_time } = decrypted;
    const paidAt = Math.floor(Date.parse(success_time) / 1000);
    await handlePaymentSuccess(out_trade_no, transaction_id, paidAt, 'wechat');
    res.status(200).json({ code: 'SUCCESS' });
  } catch (err) {
    console.error('微信回调处理失败:', err);
    res.status(500).json({ code: 'FAIL' });
  }
});

app.get('/api/pay/status/:orderNo', async (req, res) => {
  const result = await pool.query('SELECT status FROM payments WHERE order_no = $1', [req.params.orderNo]);
  if (result.rows.length === 0) return res.status(404).json({ error: '订单不存在' });
  res.json({ status: result.rows[0].status });
});

app.get('/api/pay/order/:orderNo', async (req, res) => {
  const { orderNo } = req.params;
  try {
    const result = await pool.query('SELECT user_email FROM payments WHERE order_no = $1', [orderNo]);
    if (result.rows.length === 0) return res.status(404).json({ error: '订单不存在' });
    res.json({ user_email: result.rows[0].user_email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ======================== 发送登录验证码接口 ========================
app.post('/api/send-login-code', optionalAuth, async (req, res) => {
  const { email, ref, plan } = req.body;
  if (!email) return res.status(400).json({ error: '缺少邮箱参数' });

  // 1. 检查是否已有有效订阅
  const authCheck = await pool.query(
    'SELECT payment_status, subscription_expires_at FROM email_authorizations WHERE email = $1',
    [email]
  );
  const now = Math.floor(Date.now() / 1000);
  let hasActiveSubscription = false;
  if (authCheck.rows.length > 0 && authCheck.rows[0].payment_status === 'paid') {
    const exp = authCheck.rows[0].subscription_expires_at;
    if (exp && exp > now) hasActiveSubscription = true;
  }

  // 2. 如果已有有效订阅，直接发送6位动态验证码，不处理订单和套餐
  if (hasActiveSubscription) {
    const code = generateCode();
    const expires = now + 600;
    await pool.query(
      'INSERT INTO email_verification_codes (email, code, expires_at, created_at) VALUES ($1, $2, $3, $4)',
      [email, code, expires, now]
    );
    const sent = await sendVerificationCode({
      to: email,
      subject: '登录验证码',
      text: `您的验证码是：${code}，有效期10分钟。`
    });
    if (sent) {
      res.json({ success: true, alreadyPaid: true });
    } else {
      res.status(500).json({ error: '邮件发送失败' });
    }
    return;
  }

  // 3. 无有效订阅：必须提供套餐
  if (!plan || !PLAN_PRICES[plan]) {
    return res.status(400).json({ error: '请选择套餐' });
  }

  // 处理推荐码
  let referrerEmail = null;
  if (ref) {
    const refRes = await pool.query('SELECT email FROM email_authorizations WHERE referral_code = $1', [ref]);
    if (refRes.rows.length > 0) referrerEmail = refRes.rows[0].email;
  }

  // 检查是否存在未支付订单或创建新订单
  let orderRes = await pool.query(
    `SELECT order_no FROM payments WHERE user_email = $1 AND status = 'pending' AND expires_at > $2 ORDER BY created_at DESC LIMIT 1`,
    [email, now]
  );
  let orderNo;
  if (orderRes.rows.length === 0) {
    orderNo = generateOrderNo();
    const expires = now + 1800;
    await pool.query(
      `INSERT INTO payments (order_no, user_email, amount, status, expires_at, created_at, payment_channel, plan_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [orderNo, email, PLAN_PRICES[plan], 'pending', expires, now, null, plan]
    );
  } else {
    orderNo = orderRes.rows[0].order_no;
    await pool.query(`UPDATE payments SET plan_type = $1, amount = $2 WHERE order_no = $3`, [plan, PLAN_PRICES[plan], orderNo]);
  }

  // 生成6位验证码
  const loginCode = generateCode();
  const codeExpires = now + 600;
  await pool.query(
    `INSERT INTO email_verification_codes (email, code, expires_at, created_at) VALUES ($1, $2, $3, $4)`,
    [email, loginCode, codeExpires, now]
  );
  const sent = await sendVerificationCode({
    to: email,
    subject: '登录验证码',
    text: `您的验证码是：${loginCode}，有效期10分钟。`
  });
  if (!sent) {
    return res.status(500).json({ error: '邮件发送失败' });
  }

  // 如果还没有 email_authorizations 记录，则创建一条（用于线下付款授权）
  const existAuth = await pool.query('SELECT email FROM email_authorizations WHERE email = $1', [email]);
  if (existAuth.rows.length === 0) {
    const authCode = generateCode();
    const authExpires = now + 86400;
    const referralCode = generateReferralCode();
    await pool.query(
      `INSERT INTO email_authorizations (email, auth_code, expires_at, authorized, created_at, status, payment_status, referrer_email, referral_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [email, authCode, authExpires, false, now, 'active', 'unpaid', referrerEmail, referralCode]
    );
  } else if (referrerEmail) {
    await pool.query(`UPDATE email_authorizations SET referrer_email = COALESCE(referrer_email, $1) WHERE email = $2`, [referrerEmail, email]);
  }

  res.json({ success: true, needPay: true });
});

app.post('/api/verify-login-code',
  body('email').isEmail(),
  body('code').isLength({ min: 6, max: 6 }),
  async (req, res) => {
    const { email, code } = req.body;
    const now = Math.floor(Date.now() / 1000);

    if (TEST_EMAIL && email === TEST_EMAIL && TEST_CODE && code === TEST_CODE) {
      console.log(`🔧 测试邮箱 ${email} 使用固定验证码登录`);
      const existing = await pool.query('SELECT email FROM email_authorizations WHERE email = $1', [email]);
      if (existing.rows.length === 0) {
        const authCode = generateCode();
        const expires = now + 86400 * 365;
        const referralCode = generateReferralCode();
        const farFuture = now + 100 * 365 * 86400;
        await pool.query(
          `INSERT INTO email_authorizations (email, auth_code, expires_at, authorized, created_at, status, payment_status, paid_at, referral_code, plan_type, subscription_expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [email, authCode, expires, true, now, 'active', 'paid', now, referralCode, 'test', farFuture]
        );
      } else {
        await pool.query(`UPDATE email_authorizations SET authorized = true, payment_status = 'paid', status = 'active', paid_at = COALESCE(paid_at, $1) WHERE email = $2`, [now, email]);
      }
      const token = generateAccessToken(email);
      res.cookie('access_token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: 24 * 60 * 60 * 1000 });
      return res.json({ success: true, testMode: true });
    }

    try {
      const codeRes = await pool.query('SELECT code, expires_at FROM email_verification_codes WHERE email = $1 AND code = $2', [email, code]);
      if (codeRes.rows.length > 0 && codeRes.rows[0].expires_at > now) {
        await pool.query('DELETE FROM email_verification_codes WHERE email = $1 AND code = $2', [email, code]);
        const auth = await pool.query('SELECT status, subscription_expires_at, payment_status FROM email_authorizations WHERE email = $1', [email]);
        if (auth.rows.length === 0) return res.status(400).json({ error: '用户不存在' });
        const record = auth.rows[0];
        if (record.status === 'disabled') return res.status(403).json({ error: '账号已停用' });
        if (record.payment_status !== 'paid') return res.status(403).json({ error: '尚未付款' });
        if (record.subscription_expires_at && record.subscription_expires_at < now) {
          return res.status(403).json({ error: '订阅已过期，请续费' });
        }
        const token = generateAccessToken(email);
        res.cookie('access_token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: 24 * 60 * 60 * 1000 });
        return res.json({ success: true });
      }

      const authRes = await pool.query('SELECT auth_code, expires_at, authorized, payment_status, subscription_expires_at FROM email_authorizations WHERE email = $1', [email]);
      if (authRes.rows.length === 0) return res.status(400).json({ error: '无效验证码' });
      const record = authRes.rows[0];
      if (record.authorized) return res.status(400).json({ error: '请使用6位验证码登录' });
      if (now > record.expires_at) return res.status(400).json({ error: '授权码已过期' });
      if (record.auth_code !== code) return res.status(400).json({ error: '授权码错误' });
      if (record.payment_status !== 'paid') return res.status(403).json({ error: '尚未付款' });
      if (record.subscription_expires_at && record.subscription_expires_at < now) {
        return res.status(403).json({ error: '订阅已过期，请续费' });
      }
      await pool.query('UPDATE email_authorizations SET authorized = true WHERE email = $1', [email]);
      const token = generateAccessToken(email);
      res.cookie('access_token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: 24 * 60 * 60 * 1000 });
      res.json({ success: true });
    } catch (err) {
      console.error('验证登录码出错:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

app.post('/api/logout', (req, res) => {
  res.clearCookie('access_token');
  res.json({ success: true });
});

app.get('/api/user/profile', authenticateJWT, async (req, res) => {
  const email = req.user.email;
  const now = Math.floor(Date.now() / 1000);
  try {
    const result = await pool.query('SELECT email, referral_code, commission_balance, total_earned, plan_type, subscription_expires_at FROM email_authorizations WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(404).json({ error: '用户不存在' });
    const user = result.rows[0];
    let referralLink = '';
    if (TEST_EMAIL && email === TEST_EMAIL) {
      referralLink = '';
    } else {
      referralLink = `${process.env.BASE_URL || 'http://' + req.get('host')}/?ref=${user.referral_code}`;
    }
    let daysLeft = 0;
    if (user.subscription_expires_at) {
      daysLeft = Math.max(0, Math.ceil((user.subscription_expires_at - now) / 86400));
    }
    res.json({
      email: user.email,
      referral_code: user.referral_code,
      referral_link: referralLink,
      commission_balance: user.commission_balance || 0,
      total_earned: user.total_earned || 0,
      plan_type: user.plan_type || 'none',
      subscription_expires_at: user.subscription_expires_at,
      days_left: daysLeft
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/user/commissions', authenticateJWT, async (req, res) => {
  const email = req.user.email;
  try {
    const { rows } = await pool.query('SELECT id, user_email, amount, status, created_at, paid_at, plan_type FROM commissions WHERE referrer_email = $1 ORDER BY created_at DESC', [email]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ======================== 通知系统（用户端） ========================
app.get('/api/user/notices', authenticateJWT, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, title, content, created_at FROM system_notices WHERE is_deleted = false ORDER BY created_at DESC'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ======================== 任务管理 ========================
app.get('/api/tasks', authenticateJWT, async (req, res) => {
  const email = req.user.email;
  try {
    const { rows } = await pool.query(
      `SELECT id, name, "cycleDays" as cycle_days, "warningDays" as warning_days,
              "finalDays" as final_days, "warningEmail" as warning_email,
              "finalEmail" as final_email, "warningMessage" as warning_message,
              "finalMessage" as final_message, "lastCheckin" as last_checkin,
              "needHumanConfirm" as need_human_confirm, "contactPhone" as contact_phone
       FROM tasks WHERE user_email = $1`,
      [email]
    );
    const now = Math.floor(Date.now() / 1000);
    const tasks = rows.map(task => {
      const camelTask = {
        id: task.id,
        name: task.name,
        cycleDays: task.cycle_days,
        warningDays: task.warning_days,
        finalDays: task.final_days,
        warningEmail: task.warning_email,
        finalEmail: task.final_email,
        warningMessage: task.warning_message,
        finalMessage: task.final_message,
        lastCheckin: task.last_checkin,
        contactPhone: task.contact_phone,
        need_human_confirm: task.need_human_confirm === 1,
        needHumanConfirm: task.need_human_confirm
      };
      camelTask.status = computeTaskStatus(camelTask, now);
      return camelTask;
    });
    res.json(tasks);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '获取任务失败' });
  }
});

app.get('/api/tasks/:id', authenticateJWT, param('id').notEmpty(), async (req, res) => {
  const { id } = req.params;
  const email = req.user.email;
  try {
    const { rows } = await pool.query(
      `SELECT id, name, "cycleDays" as cycle_days, "warningDays" as warning_days,
              "finalDays" as final_days, "warningEmail" as warning_email,
              "finalEmail" as final_email, "warningMessage" as warning_message,
              "finalMessage" as final_message, "lastCheckin" as last_checkin,
              "needHumanConfirm" as need_human_confirm, "contactPhone" as contact_phone
       FROM tasks WHERE id = $1 AND user_email = $2`,
      [id, email]
    );
    if (rows.length === 0) return res.status(404).json({ error: '任务不存在' });
    const task = rows[0];
    const now = Math.floor(Date.now() / 1000);
    const camelTask = {
      id: task.id,
      name: task.name,
      cycleDays: task.cycle_days,
      warningDays: task.warning_days,
      finalDays: task.final_days,
      warningEmail: task.warning_email,
      finalEmail: task.final_email,
      warningMessage: task.warning_message,
      finalMessage: task.final_message,
      lastCheckin: task.last_checkin,
      contactPhone: task.contact_phone,
      need_human_confirm: task.need_human_confirm === 1,
      needHumanConfirm: task.need_human_confirm
    };
    camelTask.status = computeTaskStatus(camelTask, now);
    res.json(camelTask);
  } catch (err) {
    res.status(500).json({ error: '获取任务失败' });
  }
});

app.post('/api/tasks',
  authenticateJWT,
  body('name').trim().isLength({ min: 1, max: 100 }),
  body('cycle_days').isInt({ min: 1, max: 365 }),
  body('warning_days').isInt({ min: 1, max: 30 }),
  body('final_days').isInt({ min: 1, max: 30 }),
  body('final_email').optional().isEmail(),
  body('warning_message').optional().isString(),
  body('final_message').optional().isString(),
  body('need_human_confirm').optional().isBoolean(),
  body('contact_phone').optional().isString(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: '输入参数无效' });
    const email = req.user.email;
    const task = req.body;
    if (task.warning_days + task.final_days > 60) return res.status(400).json({ error: '警告天数+终止天数不能超过60天' });
    if (task.final_days <= task.warning_days) return res.status(400).json({ error: '终止天数必须大于警告天数' });

    const countResult = await pool.query('SELECT COUNT(*) FROM tasks WHERE user_email = $1', [email]);
    const taskCount = parseInt(countResult.rows[0].count);
    if (taskCount >= 7) {
      return res.status(400).json({ error: '最多7个任务，请删除不需要的任务后再创建。' });
    }
    
    const now = Math.floor(Date.now() / 1000);
    const newTask = {
      id: `task_${now}_${Math.random().toString(36).substr(2, 6)}`,
      user_email: email,
      name: task.name,
      cycleDays: task.cycle_days,
      warningDays: task.warning_days,
      finalDays: task.final_days,
      warningEmail: email,
      finalEmail: task.final_email || '',
      warningMessage: task.warning_message || '',
      finalMessage: task.final_message || '',
      lastCheckin: now,
      created: now,
      warningSent: 0,
      finalSent: 0,
      warningTriggeredAt: null,
      needHumanConfirm: task.need_human_confirm ? 1 : 0,
      contactPhone: task.contact_phone || null,
      customerNotified: 0
    };
    try {
      await pool.query(
        `INSERT INTO tasks (id, user_email, name, "cycleDays", "warningDays", "finalDays", "warningEmail", "finalEmail", "warningMessage", "finalMessage", "lastCheckin", created, "warningSent", "finalSent", "warningTriggeredAt", "needHumanConfirm", "contactPhone", "customerNotified") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        Object.values(newTask)
      );
      res.json({ success: true, id: newTask.id });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: '创建任务失败' });
    }
  }
);

app.put('/api/tasks/:id',
  authenticateJWT,
  param('id').notEmpty(),
  body('name').optional().trim().isLength({ min: 1 }),
  body('cycle_days').optional().isInt({ min: 1 }),
  body('warning_days').optional().isInt({ min: 1 }),
  body('final_days').optional().isInt({ min: 1 }),
  body('final_email').optional().isEmail(),
  body('warning_message').optional().isString(),
  body('final_message').optional().isString(),
  body('need_human_confirm').optional().isBoolean(),
  body('contact_phone').optional().isString(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: '输入参数无效' });
    const { id } = req.params;
    const email = req.user.email;
    const updates = req.body;
    const setParts = [];
    const values = [];
    let idx = 1;
    if (updates.name !== undefined) { setParts.push(`"name" = $${idx++}`); values.push(updates.name); }
    if (updates.cycle_days !== undefined) { setParts.push(`"cycleDays" = $${idx++}`); values.push(updates.cycle_days); }
    if (updates.warning_days !== undefined) { setParts.push(`"warningDays" = $${idx++}`); values.push(updates.warning_days); }
    if (updates.final_days !== undefined) { setParts.push(`"finalDays" = $${idx++}`); values.push(updates.final_days); }
    if (updates.final_email !== undefined) { setParts.push(`"finalEmail" = $${idx++}`); values.push(updates.final_email); }
    if (updates.warning_message !== undefined) { setParts.push(`"warningMessage" = $${idx++}`); values.push(updates.warning_message); }
    if (updates.final_message !== undefined) { setParts.push(`"finalMessage" = $${idx++}`); values.push(updates.final_message); }
    if (updates.need_human_confirm !== undefined) { setParts.push(`"needHumanConfirm" = $${idx++}`); values.push(updates.need_human_confirm ? 1 : 0); }
    if (updates.contact_phone !== undefined) { setParts.push(`"contactPhone" = $${idx++}`); values.push(updates.contact_phone); }
    if (setParts.length === 0) return res.status(400).json({ error: '无更新字段' });
    values.push(id, email);
    const query = `UPDATE tasks SET ${setParts.join(', ')} WHERE id = $${idx++} AND user_email = $${idx++}`;
    try {
      const result = await pool.query(query, values);
      if (result.rowCount === 0) return res.status(404).json({ error: '任务不存在或无权操作' });
      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: '更新失败' });
    }
  }
);

app.delete('/api/tasks/:id', authenticateJWT, param('id').notEmpty(), async (req, res) => {
  const { id } = req.params;
  const email = req.user.email;
  try {
    const result = await pool.query('DELETE FROM tasks WHERE id = $1 AND user_email = $2', [id, email]);
    if (result.rowCount === 0) return res.status(404).json({ error: '任务不存在' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '删除失败' });
  }
});

app.post('/api/tasks/:id/checkin', authenticateJWT, param('id').notEmpty(), async (req, res) => {
  const { id } = req.params;
  const email = req.user.email;
  const now = Math.floor(Date.now() / 1000);
  try {
    const result = await pool.query(
      `UPDATE tasks SET "lastCheckin" = $1, "warningSent" = 0, "finalSent" = 0, "warningTriggeredAt" = NULL, "customerNotified" = 0 WHERE id = $2 AND user_email = $3`,
      [now, id, email]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: '任务不存在' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '打卡失败' });
  }
});

app.post('/api/auto-checkin', authenticateJWT, async (req, res) => {
  const email = req.user.email;
  const now = Math.floor(Date.now() / 1000);
  try {
    await pool.query(
      `UPDATE tasks SET "lastCheckin" = $1, "warningSent" = 0, "finalSent" = 0, "warningTriggeredAt" = NULL, "customerNotified" = 0 WHERE user_email = $2`,
      [now, email]
    );
    const { rows } = await pool.query(
      `SELECT id, name, "cycleDays" as cycle_days, "warningDays" as warning_days,
              "finalDays" as final_days, "warningEmail" as warning_email,
              "finalEmail" as final_email, "warningMessage" as warning_message,
              "finalMessage" as final_message, "lastCheckin" as last_checkin,
              "needHumanConfirm" as need_human_confirm, "contactPhone" as contact_phone
       FROM tasks WHERE user_email = $1`,
      [email]
    );
    const nowTs = Math.floor(Date.now() / 1000);
    const tasks = rows.map(task => {
      const camelTask = {
        id: task.id,
        name: task.name,
        cycleDays: task.cycle_days,
        warningDays: task.warning_days,
        finalDays: task.final_days,
        warningEmail: task.warning_email,
        finalEmail: task.final_email,
        warningMessage: task.warning_message,
        finalMessage: task.final_message,
        lastCheckin: task.last_checkin,
        contactPhone: task.contact_phone,
        need_human_confirm: task.need_human_confirm === 1,
        needHumanConfirm: task.need_human_confirm
      };
      camelTask.status = computeTaskStatus(camelTask, nowTs);
      return camelTask;
    });
    res.json({ success: true, count: rows.length, tasks });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '一键打卡失败' });
  }
});

// ======================== 管理员后台接口 ========================
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码必填' });
  try {
    const result = await pool.query('SELECT id, username, password_hash, role FROM admin_users WHERE username = $1', [username]);
    if (result.rows.length === 0) return res.status(401).json({ error: '用户名或密码错误' });
    const admin = result.rows[0];
    const match = await bcrypt.compare(password, admin.password_hash);
    if (!match) return res.status(401).json({ error: '用户名或密码错误' });
    const token = generateAdminToken(admin.username, admin.role);
    res.json({ success: true, token, role: admin.role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/users', verifyAdminToken, requireSuperAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, username, role, created_at FROM admin_users ORDER BY id');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/users', verifyAdminToken, requireSuperAdmin, async (req, res) => {
  const { username, password, role = 'admin' } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码必填' });
  if (!['admin', 'super'].includes(role)) return res.status(400).json({ error: '角色无效' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const now = Math.floor(Date.now() / 1000);
    await pool.query('INSERT INTO admin_users (username, password_hash, role, created_at) VALUES ($1,$2,$3,$4)', [username, hash, role, now]);
    res.json({ success: true });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: '用户名已存在' });
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/users/:id', verifyAdminToken, requireSuperAdmin, async (req, res) => {
  const { id } = req.params;
  const currentUser = req.admin.username;
  if (currentUser === 'admin' && id === '1') return res.status(403).json({ error: '不能删除初始超级管理员' });
  try {
    const result = await pool.query('DELETE FROM admin_users WHERE id = $1', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: '管理员不存在' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/notices', verifyAdminToken, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, title, content, is_deleted, created_at FROM system_notices ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/notice', verifyAdminToken, async (req, res) => {
  const { title, content } = req.body;
  if (!title || !content) return res.status(400).json({ error: '标题和内容不能为空' });
  try {
    const now = Math.floor(Date.now() / 1000);
    await pool.query(
      'INSERT INTO system_notices (title, content, is_deleted, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)',
      [title, content, false, now, now]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/notice/:id', verifyAdminToken, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM system_notices WHERE id = $1', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: '通知不存在' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/customer/pending-tasks', verifyAdminToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, user_email, name, "finalEmail", "contactPhone", "lastCheckin"
       FROM tasks WHERE "needHumanConfirm" = 1 AND "finalSent" = 0 AND "customerNotified" = 1`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/customer/send-final/:taskId', verifyAdminToken, async (req, res) => {
  const { taskId } = req.params;
  try {
    const { rows } = await pool.query('SELECT * FROM tasks WHERE id = $1', [taskId]);
    if (rows.length === 0) return res.status(404).json({ error: '任务不存在' });
    const task = rows[0];
    if (!task.needHumanConfirm || task.finalSent) {
      return res.status(400).json({ error: '该任务无需人工确认或已发送终止通知' });
    }
    const baseText = task.finalMessage || '您已连续多日未打卡，任务已终止。';
    const mailText = `来自 ${task.user_email} 的终止通知：\n\n${baseText}`;
    const success = await sendVerificationCode({
      to: task.finalEmail,
      subject: '【心灵保险】任务终止通知',
      text: mailText
    });
    if (success) {
      await pool.query('UPDATE tasks SET "finalSent" = 1 WHERE id = $1', [taskId]);
      res.json({ success: true });
    } else {
      res.status(500).json({ error: '邮件发送失败' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/pending-auths', verifyAdminToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT email, auth_code, created_at, expires_at, payment_status, referrer_email
       FROM email_authorizations 
       WHERE authorized = false AND expires_at > $1
       ORDER BY created_at DESC`,
      [Math.floor(Date.now() / 1000)]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/manage-emails', verifyAdminToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT email, auth_code, authorized, status, created_at, payment_status, paid_at, referrer_email, commission_balance, total_earned, plan_type, subscription_expires_at
       FROM email_authorizations 
       ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/commissions', verifyAdminToken, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM commissions ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin-api/tasks', verifyAdminToken, async (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: '缺少邮箱参数' });
  try {
    const { rows } = await pool.query(
      `SELECT id, name, "cycleDays" as cycle_days, "warningDays" as warning_days,
              "finalDays" as final_days, "warningEmail" as warning_email,
              "finalEmail" as final_email, "warningMessage" as warning_message,
              "finalMessage" as final_message, "lastCheckin" as last_checkin,
              "needHumanConfirm" as need_human_confirm, "contactPhone" as contact_phone
       FROM tasks WHERE user_email = $1`,
      [email]
    );
    const now = Math.floor(Date.now() / 1000);
    const tasks = rows.map(task => {
      const camelTask = {
        ...task,
        cycleDays: task.cycle_days,
        warningDays: task.warning_days,
        finalDays: task.final_days,
        lastCheckin: task.last_checkin,
        warningEmail: task.warning_email,
        finalEmail: task.final_email,
        warningMessage: task.warning_message,
        finalMessage: task.final_message,
        contactPhone: task.contact_phone,
        needHumanConfirm: task.need_human_confirm === 1
      };
      camelTask.status = computeTaskStatus(camelTask, now);
      return camelTask;
    });
    res.json(tasks);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/confirm-payment', verifyAdminToken, async (req, res) => {
  const { email, plan_type } = req.body;
  if (!email) return res.status(400).json({ error: '缺少邮箱' });
  const plan = plan_type || '1y';
  if (!PLAN_PRICES[plan]) return res.status(400).json({ error: '无效套餐' });
  try {
    const now = Math.floor(Date.now() / 1000);
    const daysToAdd = PLAN_DAYS[plan];
    const newExpiration = now + daysToAdd * 86400;

    const before = await pool.query('SELECT payment_status FROM email_authorizations WHERE email = $1', [email]);
    const wasPaid = before.rows[0]?.payment_status === 'paid';

    const result = await pool.query(
      `UPDATE email_authorizations 
       SET payment_status = 'paid', paid_at = $1, plan_type = $2, subscription_expires_at = $3, authorized = true
       WHERE email = $4 AND payment_status = 'unpaid'`,
      [now, plan, newExpiration, email]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: '未找到待确认付款的邮箱或已付款' });
    }

    if (!wasPaid) {
      const userRec = await pool.query('SELECT referrer_email FROM email_authorizations WHERE email = $1', [email]);
      const referrerEmail = userRec.rows[0]?.referrer_email;
      if (referrerEmail) {
        const rewardAmount = PLAN_REWARDS[plan] || 0;
        if (rewardAmount > 0) {
          await pool.query(
            `INSERT INTO commissions (referrer_email, user_email, amount, status, created_at, plan_type)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [referrerEmail, email, rewardAmount, 'pending', now, plan]
          );
          await pool.query(
            `UPDATE email_authorizations 
             SET commission_balance = commission_balance + $1, total_earned = total_earned + $1
             WHERE email = $2`,
            [rewardAmount, referrerEmail]
          );
          const rewardYuan = (rewardAmount / 100).toFixed(2);
          await sendVerificationCode({
            to: referrerEmail,
            subject: '【心灵保险】您推荐的用户已付款，返利待发放',
            text: `您推荐的用户 ${email} 购买了 ${plan} 套餐，您将获得 ${rewardYuan} 元返利。请等待管理员线下转账。`
          });
        }
      }
    } else {
      console.log(`📌 管理员确认付款：用户 ${email} 已是付费用户，不重复发放推荐奖励`);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/send-auth-code', verifyAdminToken, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: '缺少邮箱' });
  const check = await pool.query('SELECT payment_status FROM email_authorizations WHERE email = $1', [email]);
  if (check.rows.length === 0) return res.status(404).json({ error: '邮箱不存在' });
  if (check.rows[0].payment_status !== 'paid') {
    return res.status(403).json({ error: '该邮箱尚未确认付款，请先确认收款' });
  }
  const result = await pool.query(
    'SELECT auth_code FROM email_authorizations WHERE email = $1 AND authorized = false AND expires_at > $2',
    [email, Math.floor(Date.now() / 1000)]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: '无有效的待授权记录' });
  }
  const authCode = result.rows[0].auth_code;
  const success = await sendVerificationCode({
    to: email,
    subject: '【心灵保险】您的邮箱授权码',
    text: `您的邮箱授权码是：${authCode}，有效期24小时。`
  });
  if (success) res.json({ success: true });
  else res.status(500).json({ error: '邮件发送失败' });
});

app.post('/api/admin/mark-commission-paid', verifyAdminToken, async (req, res) => {
  const { commission_id } = req.body;
  if (!commission_id) return res.status(400).json({ error: '缺少返利ID' });
  try {
    const now = Math.floor(Date.now() / 1000);
    const commission = await pool.query('SELECT referrer_email, amount, status FROM commissions WHERE id = $1', [commission_id]);
    if (commission.rows.length === 0) return res.status(404).json({ error: '返利记录不存在' });
    if (commission.rows[0].status !== 'pending') return res.status(400).json({ error: '返利记录已处理' });
    const { referrer_email, amount } = commission.rows[0];

    await pool.query('BEGIN');
    await pool.query('UPDATE commissions SET status = $1, paid_at = $2 WHERE id = $3', ['paid', now, commission_id]);
    await pool.query(
      'UPDATE email_authorizations SET commission_balance = commission_balance - $1 WHERE email = $2 AND commission_balance >= $1',
      [amount, referrer_email]
    );
    await pool.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/disable-email', verifyAdminToken, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: '缺少邮箱' });
  await pool.query('UPDATE email_authorizations SET status = $1 WHERE email = $2', ['disabled', email]);
  res.json({ success: true });
});

app.post('/api/admin/enable-email', verifyAdminToken, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: '缺少邮箱' });
  await pool.query('UPDATE email_authorizations SET status = $1 WHERE email = $2', ['active', email]);
  res.json({ success: true });
});

app.post('/api/admin/delete-email', verifyAdminToken, requireSuperAdmin, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: '缺少邮箱' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const commissions = await client.query('SELECT id, referrer_email, amount FROM commissions WHERE user_email = $1', [email]);
    for (const row of commissions.rows) {
      const { referrer_email, amount } = row;
      await client.query(
        `UPDATE email_authorizations 
         SET commission_balance = GREATEST(commission_balance - $1, 0) 
         WHERE email = $2`,
        [amount, referrer_email]
      );
    }
    await client.query('DELETE FROM commissions WHERE referrer_email = $1 OR user_email = $1', [email]);
    await client.query('DELETE FROM tasks WHERE user_email = $1', [email]);
    await client.query('DELETE FROM payments WHERE user_email = $1', [email]);
    await client.query('DELETE FROM email_authorizations WHERE email = $1', [email]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('删除邮箱失败:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/admin/update-expiration', verifyAdminToken, async (req, res) => {
  const { email, add_days, new_expiration_timestamp } = req.body;
  if (!email) return res.status(400).json({ error: '缺少邮箱' });
  try {
    const now = Math.floor(Date.now() / 1000);
    let finalExpiration = null;
    if (new_expiration_timestamp) {
      finalExpiration = new_expiration_timestamp;
    } else if (add_days && !isNaN(add_days)) {
      const current = await pool.query('SELECT subscription_expires_at FROM email_authorizations WHERE email = $1', [email]);
      const currentExp = current.rows[0]?.subscription_expires_at || now;
      finalExpiration = Math.max(currentExp, now) + add_days * 86400;
    } else {
      return res.status(400).json({ error: '请提供 add_days 或 new_expiration_timestamp' });
    }
    await pool.query('UPDATE email_authorizations SET subscription_expires_at = $1 WHERE email = $2', [finalExpiration, email]);
    res.json({ success: true, new_expiration: finalExpiration });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/trigger-check', verifyAdminToken, async (req, res) => {
  console.log(`🔧 手工触发定时任务检查`);
  try {
    let offset = 0;
    const limit = 1000;
    let hasMore = true;
    let total = 0;
    while (hasMore) {
      const { rows: tasks } = await pool.query('SELECT * FROM tasks ORDER BY id LIMIT $1 OFFSET $2', [limit, offset]);
      for (const task of tasks) {
        await checkTask(task);
        total++;
      }
      offset += limit;
      hasMore = tasks.length === limit;
    }
    res.json({ success: true, processed: total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function checkTask(task) {
  const now = Math.floor(Date.now() / 1000);
  const diffSec = now - task.lastCheckin;
  const daysSince = Math.floor(diffSec / (24 * 60 * 60));
  const cycleDays = task.cycleDays;
  const warningDays = task.warningDays;
  const finalDays = task.finalDays;
  if (daysSince <= cycleDays) return;
  const overdueDays = daysSince - cycleDays;
  if (overdueDays >= warningDays && overdueDays < warningDays + finalDays) {
    if (!task.warningSent) {
      const success = await sendVerificationCode({
        to: task.warningEmail,
        subject: '【心灵保险】打卡警告',
        text: task.warningMessage || `您已连续 ${overdueDays} 天未打卡，请及时打卡。`
      });
      if (success) {
        await pool.query('UPDATE tasks SET "warningSent" = 1, "warningTriggeredAt" = $1 WHERE id = $2', [now, task.id]);
      }
    }
    return;
  }
  if (overdueDays >= warningDays + finalDays) {
    if (task.needHumanConfirm) {
      if (!task.customerNotified) {
        const customerEmail = process.env.SMTP_USER;
        const contactPhone = task.contactPhone || '未提供';
        const confirmLink = `${process.env.BASE_URL}/admin.html?token=${process.env.CUSTOMER_TOKEN || ''}`;
        const mailText = `任务 "${task.name}" 已到达终止条件，需要人工确认。\n- 用户邮箱：${task.user_email}\n- 监督人邮箱：${task.finalEmail}\n- 联系电话：${contactPhone}\n- 最后打卡：${new Date(task.lastCheckin * 1000).toLocaleString()}\n请登录客服界面处理：${confirmLink}`;
        const success = await sendVerificationCode({
          to: customerEmail,
          subject: '【心灵保险】客服人工确认提醒',
          text: mailText
        });
        if (success) {
          await pool.query('UPDATE tasks SET "customerNotified" = 1 WHERE id = $1', [task.id]);
        }
      }
    } else {
      if (!task.finalSent) {
        const baseText = task.finalMessage || `您已连续 ${overdueDays} 天未打卡，任务已终止。`;
        const finalMailText = `来自 ${task.user_email} 的终止通知：\n\n${baseText}`;
        const success = await sendVerificationCode({
          to: task.finalEmail,
          subject: '【心灵保险】任务终止通知',
          text: finalMailText
        });
        if (success) {
          await pool.query('UPDATE tasks SET "finalSent" = 1 WHERE id = $1', [task.id]);
        }
      }
    }
  }
}

app.use((err, req, res, next) => {
  console.error('全局错误:', err);
  res.status(500).json({ error: '服务器内部错误' });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, '0.0.0.0', () => {
  console.log(`✅ 后端服务运行在端口 ${port}`);
  console.log(`📌 套餐价格: 1年 ${PLAN_PRICES['1y']/100}元, 2年 ${PLAN_PRICES['2y']/100}元, 3年 ${PLAN_PRICES['3y']/100}元`);
  console.log(`🎁 推荐奖励: 1年 ${PLAN_REWARDS['1y']/100}元, 2年 ${PLAN_REWARDS['2y']/100}元, 3年 ${PLAN_REWARDS['3y']/100}元`);
  if (TEST_EMAIL && TEST_CODE) {
    console.log(`🔧 测试模式已启用：邮箱 ${TEST_EMAIL} 可使用固定验证码 ${TEST_CODE} 登录`);
  }
  pool.query('SELECT NOW()', (err, dbRes) => {
    if (err) console.error('❌ 数据库连接失败', err.message);
    else console.log('✅ 数据库连接正常');
  });
});