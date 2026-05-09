require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');
const cron = require('node-cron');
const path = require('path');
const jwt = require('jsonwebtoken');
const { body, validationResult, param } = require('express-validator');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const validator = require('validator');
const { Resend } = require('resend');

const app = express();
const port = process.env.PORT || 3000;

// 套餐及奖励配置
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

// 数据库连接池
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

// JWT 配置
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
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Login expired' });
  }
}

const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || JWT_SECRET + '_admin';
function generateAdminToken(username, role) {
  return jwt.sign({ username, role }, ADMIN_JWT_SECRET, { expiresIn: '8h' });
}
function verifyAdminToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Missing admin token' });
  try {
    const decoded = jwt.verify(token, ADMIN_JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid admin token' });
  }
}
function requireSuperAdmin(req, res, next) {
  if (req.admin.role !== 'super') return res.status(403).json({ error: 'Super admin required' });
  next();
}

// Resend 邮件服务
const resend = new Resend(process.env.RESEND_API_KEY);
async function sendEmail({ to, subject, text }) {
  try {
    const { data, error } = await resend.emails.send({
      from: `Mind Insurance <service@${process.env.DOMAIN || 'mindapp.online'}>`,
      to: [to],
      subject: subject,
      html: `<p>${text.replace(/\n/g, '<br>')}</p>`
    });
    if (error) {
      console.error('Resend error:', error);
      return false;
    }
    console.log('Email sent:', data);
    return true;
  } catch (err) {
    console.error('Email error:', err);
    return false;
  }
}

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}
function generateReferralCode() {
  return Math.random().toString(36).substring(2, 10).toUpperCase();
}
function generateOrderNo() {
  return `PAY${Date.now()}${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
}

// 定时清理过期数据
cron.schedule('0 * * * *', async () => {
  const now = Math.floor(Date.now() / 1000);
  await pool.query('DELETE FROM email_verification_codes WHERE expires_at < $1', [now]);
  await pool.query('UPDATE payments SET status = $1 WHERE expires_at < $2 AND status = $3', ['expired', now, 'pending']);
  console.log('Cleaned expired codes and orders');
}, { timezone: 'Asia/Shanghai' });

cron.schedule('0 5 * * *', async () => {
  console.log(`⏰ Daily task check at 5:00 ${new Date().toLocaleString('zh-CN')}`);
  try {
    let offset = 0;
    const limit = 1000;
    let hasMore = true;
    while (hasMore) {
      const { rows: tasks } = await pool.query('SELECT * FROM tasks ORDER BY id LIMIT $1 OFFSET $2', [limit, offset]);
      for (const task of tasks) await checkTask(task);
      offset += limit;
      hasMore = tasks.length === limit;
    }
  } catch (err) {
    console.error('Cron job failed:', err);
  }
}, { timezone: 'Asia/Shanghai' });

function computeTaskStatus(task, now = Math.floor(Date.now() / 1000)) {
  const diffSec = now - task.lastCheckin;
  const daysSince = Math.floor(diffSec / (24 * 60 * 60));
  if (daysSince <= task.cycleDays) return 'normal';
  const overdueDays = daysSince - task.cycleDays;
  if (overdueDays < task.warningDays) return 'normal';
  if (overdueDays < task.warningDays + task.finalDays) return 'warning';
  return 'final';
}

// 支付成功处理（未实际使用，但保留）
async function handlePaymentSuccess(orderNo, transactionId, paidAtUnix, channel) {
  console.log(`⚠️ Unexpected payment success call: ${orderNo}, ${channel}`);
  return false;
}

// ======================== API Routes ========================
app.get('/api/config', (req, res) => {
  const plans = [
    { id: '1y', name: '1-Year Plan', price: PLAN_PRICES['1y'], price_yuan: (PLAN_PRICES['1y']/100).toFixed(2), days: PLAN_DAYS['1y'], reward: PLAN_REWARDS['1y'], reward_yuan: (PLAN_REWARDS['1y']/100).toFixed(2) },
    { id: '2y', name: '2-Year Plan', price: PLAN_PRICES['2y'], price_yuan: (PLAN_PRICES['2y']/100).toFixed(2), days: PLAN_DAYS['2y'], reward: PLAN_REWARDS['2y'], reward_yuan: (PLAN_REWARDS['2y']/100).toFixed(2) },
    { id: '3y', name: '3-Year Plan', price: PLAN_PRICES['3y'], price_yuan: (PLAN_PRICES['3y']/100).toFixed(2), days: PLAN_DAYS['3y'], reward: PLAN_REWARDS['3y'], reward_yuan: (PLAN_REWARDS['3y']/100).toFixed(2) }
  ];
  res.json({ plans });
});

app.post('/api/check-subscription', async (req, res) => {
  const { email } = req.body;
  if (!email || !validator.isEmail(email)) return res.status(400).json({ error: 'Invalid email' });
  try {
    const result = await pool.query('SELECT payment_status, subscription_expires_at FROM email_authorizations WHERE email = $1', [email]);
    const now = Math.floor(Date.now() / 1000);
    let hasActive = false;
    if (result.rows.length > 0 && result.rows[0].payment_status === 'paid') {
      const expiresAt = result.rows[0].subscription_expires_at;
      if (expiresAt && expiresAt > now) hasActive = true;
    }
    res.json({ hasActiveSubscription: hasActive });
  } catch (err) {
    res.status(500).json({ error: 'Query failed' });
  }
});

async function optionalAuth(req, res, next) {
  const token = req.cookies.access_token;
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
    } catch(e) {}
  }
  next();
}

// 发送登录验证码（无支付）
app.post('/api/send-login-code', optionalAuth, async (req, res) => {
  const { email, ref, plan } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  // 检查是否已有有效订阅
  const authCheck = await pool.query('SELECT payment_status, subscription_expires_at FROM email_authorizations WHERE email = $1', [email]);
  const now = Math.floor(Date.now() / 1000);
  let hasActiveSubscription = false;
  if (authCheck.rows.length > 0 && authCheck.rows[0].payment_status === 'paid') {
    const exp = authCheck.rows[0].subscription_expires_at;
    if (exp && exp > now) hasActiveSubscription = true;
  }

  if (hasActiveSubscription) {
    const code = generateCode();
    const expires = now + 600;
    await pool.query('INSERT INTO email_verification_codes (email, code, expires_at, created_at) VALUES ($1, $2, $3, $4)', [email, code, expires, now]);
    const sent = await sendEmail({ to: email, subject: 'Login Verification Code', text: `Your verification code is: ${code}\nValid for 10 minutes.` });
    if (sent) res.json({ success: true, alreadyPaid: true });
    else res.status(500).json({ error: 'Failed to send email' });
    return;
  }

  // 未付费：提示需要联系管理员（支付不可用）
  if (!plan || !PLAN_PRICES[plan]) return res.status(400).json({ error: 'Please select a plan' });

  // 处理推荐码
  let referrerEmail = null;
  if (ref) {
    const refRes = await pool.query('SELECT email FROM email_authorizations WHERE referral_code = $1', [ref]);
    if (refRes.rows.length) referrerEmail = refRes.rows[0].email;
  }

  // 创建授权记录（用于线下付款）
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
    await pool.query('UPDATE email_authorizations SET referrer_email = COALESCE(referrer_email, $1) WHERE email = $2', [referrerEmail, email]);
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
      console.log(`🧪 Test login: ${email} using fixed code`);
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
        await pool.query('UPDATE email_authorizations SET authorized = true, payment_status = $1, status = $2, paid_at = COALESCE(paid_at, $3) WHERE email = $4', ['paid', 'active', now, email]);
      }
      const token = generateAccessToken(email);
      res.cookie('access_token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: 24 * 60 * 60 * 1000 });
      return res.json({ success: true, testMode: true });
    }

    try {
      // 首先验证动态验证码
      const codeRes = await pool.query('SELECT code, expires_at FROM email_verification_codes WHERE email = $1 AND code = $2', [email, code]);
      if (codeRes.rows.length > 0 && codeRes.rows[0].expires_at > now) {
        await pool.query('DELETE FROM email_verification_codes WHERE email = $1 AND code = $2', [email, code]);
        const auth = await pool.query('SELECT status, subscription_expires_at, payment_status FROM email_authorizations WHERE email = $1', [email]);
        if (auth.rows.length === 0) return res.status(400).json({ error: 'User not found' });
        const record = auth.rows[0];
        if (record.status === 'disabled') return res.status(403).json({ error: 'Account disabled' });
        if (record.payment_status !== 'paid') return res.status(403).json({ error: 'Not paid yet' });
        if (record.subscription_expires_at && record.subscription_expires_at < now) {
          return res.status(403).json({ error: 'Subscription expired, please renew' });
        }
        const token = generateAccessToken(email);
        res.cookie('access_token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: 24 * 60 * 60 * 1000 });
        return res.json({ success: true });
      }

      // 验证授权码（24位，用于线下付款后）
      const authRes = await pool.query('SELECT auth_code, expires_at, authorized, payment_status, subscription_expires_at FROM email_authorizations WHERE email = $1', [email]);
      if (authRes.rows.length === 0) return res.status(400).json({ error: 'Invalid code' });
      const record = authRes.rows[0];
      if (record.authorized) return res.status(400).json({ error: 'Please use the 6‑digit verification code' });
      if (now > record.expires_at) return res.status(400).json({ error: 'Authorization code expired' });
      if (record.auth_code !== code) return res.status(400).json({ error: 'Wrong authorization code' });
      if (record.payment_status !== 'paid') return res.status(403).json({ error: 'Not paid yet' });
      if (record.subscription_expires_at && record.subscription_expires_at < now) {
        return res.status(403).json({ error: 'Subscription expired, please renew' });
      }
      await pool.query('UPDATE email_authorizations SET authorized = true WHERE email = $1', [email]);
      const token = generateAccessToken(email);
      res.cookie('access_token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: 24 * 60 * 60 * 1000 });
      res.json({ success: true });
    } catch (err) {
      console.error('Login verification error:', err);
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
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = result.rows[0];
    let referralLink = '';
    if (TEST_EMAIL && email === TEST_EMAIL) referralLink = '';
    else referralLink = `${process.env.BASE_URL || 'http://' + req.get('host')}/?ref=${user.referral_code}`;
    let daysLeft = 0;
    if (user.subscription_expires_at) daysLeft = Math.max(0, Math.ceil((user.subscription_expires_at - now) / 86400));
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

app.get('/api/user/notices', authenticateJWT, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, title, content, created_at FROM system_notices WHERE is_deleted = false ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ======================== 任务管理（统一使用下划线字段） ========================
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
    const tasks = rows.map(task => ({
      ...task,
      need_human_confirm: task.need_human_confirm === 1,
      status: computeTaskStatus({
        cycleDays: task.cycle_days,
        warningDays: task.warning_days,
        finalDays: task.final_days,
        lastCheckin: task.last_checkin
      }, now)
    }));
    res.json(tasks);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get tasks' });
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
    if (rows.length === 0) return res.status(404).json({ error: 'Task not found' });
    const task = rows[0];
    const now = Math.floor(Date.now() / 1000);
    res.json({
      id: task.id,
      name: task.name,
      cycle_days: task.cycle_days,
      warning_days: task.warning_days,
      final_days: task.final_days,
      warning_email: task.warning_email,
      final_email: task.final_email,
      warning_message: task.warning_message,
      final_message: task.final_message,
      last_checkin: task.last_checkin,
      contact_phone: task.contact_phone,
      need_human_confirm: task.need_human_confirm === 1,
      status: computeTaskStatus({
        cycleDays: task.cycle_days,
        warningDays: task.warning_days,
        finalDays: task.final_days,
        lastCheckin: task.last_checkin
      }, now)
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get task' });
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
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid input' });
    const email = req.user.email;
    const task = req.body;
    if (task.warning_days + task.final_days > 60) return res.status(400).json({ error: 'Warning+Fianl days cannot exceed 60' });
    if (task.final_days <= task.warning_days) return res.status(400).json({ error: 'Final days must be greater than warning days' });

    const countResult = await pool.query('SELECT COUNT(*) FROM tasks WHERE user_email = $1', [email]);
    const taskCount = parseInt(countResult.rows[0].count);
    if (taskCount >= 7) return res.status(400).json({ error: 'Max 7 tasks per user' });

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
        `INSERT INTO tasks (id, user_email, name, "cycleDays", "warningDays", "finalDays", "warningEmail", "finalEmail", "warningMessage", "finalMessage", "lastCheckin", created, "warningSent", "finalSent", "warningTriggeredAt", "needHumanConfirm", "contactPhone", "customerNotified")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        Object.values(newTask)
      );
      res.json({ success: true, id: newTask.id });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to create task' });
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
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid input' });
    const { id } = req.params;
    const email = req.user.email;
    const updates = req.body;
    // 验证 final_days > warning_days
    if (updates.warning_days !== undefined && updates.final_days !== undefined && updates.final_days <= updates.warning_days)
      return res.status(400).json({ error: 'Final days must be greater than warning days' });
    if (updates.final_days !== undefined) {
      const existing = await pool.query('SELECT "warningDays" FROM tasks WHERE id = $1 AND user_email = $2', [id, email]);
      if (existing.rows.length && existing.rows[0].warningDays >= updates.final_days)
        return res.status(400).json({ error: 'Final days must be greater than warning days' });
    }
    if (updates.warning_days !== undefined) {
      const existing = await pool.query('SELECT "finalDays" FROM tasks WHERE id = $1 AND user_email = $2', [id, email]);
      if (existing.rows.length && updates.warning_days >= existing.rows[0].finalDays)
        return res.status(400).json({ error: 'Final days must be greater than warning days' });
    }

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
    if (setParts.length === 0) return res.status(400).json({ error: 'No fields to update' });
    values.push(id, email);
    const query = `UPDATE tasks SET ${setParts.join(', ')} WHERE id = $${idx++} AND user_email = $${idx++}`;
    try {
      const result = await pool.query(query, values);
      if (result.rowCount === 0) return res.status(404).json({ error: 'Task not found' });
      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Update failed' });
    }
  }
);

app.delete('/api/tasks/:id', authenticateJWT, param('id').notEmpty(), async (req, res) => {
  const { id } = req.params;
  const email = req.user.email;
  try {
    const result = await pool.query('DELETE FROM tasks WHERE id = $1 AND user_email = $2', [id, email]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Task not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Delete failed' });
  }
});

app.post('/api/tasks/:id/checkin', authenticateJWT, param('id').notEmpty(), async (req, res) => {
  const { id } = req.params;
  const email = req.user.email;
  const now = Math.floor(Date.now() / 1000);
  try {
    await pool.query(
      `UPDATE tasks SET "lastCheckin" = $1, "warningSent" = 0, "finalSent" = 0, "warningTriggeredAt" = NULL, "customerNotified" = 0 WHERE id = $2 AND user_email = $3`,
      [now, id, email]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Check-in failed' });
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
    const tasks = rows.map(task => ({
      ...task,
      need_human_confirm: task.need_human_confirm === 1,
      status: computeTaskStatus({
        cycleDays: task.cycle_days,
        warningDays: task.warning_days,
        finalDays: task.final_days,
        lastCheckin: task.last_checkin
      }, nowTs)
    }));
    res.json({ success: true, count: rows.length, tasks });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Auto check-in failed' });
  }
});

// ======================== 管理员后台接口（与之前相同，但保持字段一致） ========================
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const result = await pool.query('SELECT id, username, password_hash, role FROM admin_users WHERE username = $1', [username]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
    const admin = result.rows[0];
    const match = await bcrypt.compare(password, admin.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
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
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (!['admin', 'super'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const now = Math.floor(Date.now() / 1000);
    await pool.query('INSERT INTO admin_users (username, password_hash, role, created_at) VALUES ($1,$2,$3,$4)', [username, hash, role, now]);
    res.json({ success: true });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Username already exists' });
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/users/:id', verifyAdminToken, requireSuperAdmin, async (req, res) => {
  const { id } = req.params;
  const currentUser = req.admin.username;
  if (currentUser === 'admin' && id === '1') return res.status(403).json({ error: 'Cannot delete initial super admin' });
  try {
    const result = await pool.query('DELETE FROM admin_users WHERE id = $1', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Admin not found' });
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
  if (!title || !content) return res.status(400).json({ error: 'Title and content required' });
  try {
    const now = Math.floor(Date.now() / 1000);
    await pool.query('INSERT INTO system_notices (title, content, is_deleted, created_at, updated_at) VALUES ($1,$2,$3,$4,$5)', [title, content, false, now, now]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/notice/:id', verifyAdminToken, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM system_notices WHERE id = $1', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Notice not found' });
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
    if (rows.length === 0) return res.status(404).json({ error: 'Task not found' });
    const task = rows[0];
    if (!task.needHumanConfirm || task.finalSent) return res.status(400).json({ error: 'Task not pending or already sent' });
    const baseText = task.finalMessage || 'You have missed check-ins for many days, task terminated.';
    const mailText = `Termination notice from ${task.user_email}:\n\n${baseText}`;
    const success = await sendEmail({ to: task.finalEmail, subject: '[Mind Insurance] Task Termination Notice', text: mailText });
    if (success) {
      await pool.query('UPDATE tasks SET "finalSent" = 1 WHERE id = $1', [taskId]);
      res.json({ success: true });
    } else {
      res.status(500).json({ error: 'Failed to send email' });
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
  if (!email) return res.status(400).json({ error: 'Missing email' });
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
    const tasks = rows.map(task => ({
      ...task,
      need_human_confirm: task.need_human_confirm === 1,
      status: computeTaskStatus({
        cycleDays: task.cycle_days,
        warningDays: task.warning_days,
        finalDays: task.final_days,
        lastCheckin: task.last_checkin
      }, now)
    }));
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/confirm-payment', verifyAdminToken, async (req, res) => {
  const { email, plan_type } = req.body;
  if (!email) return res.status(400).json({ error: 'Missing email' });
  const plan = plan_type || '1y';
  if (!PLAN_PRICES[plan]) return res.status(400).json({ error: 'Invalid plan' });
  try {
    const now = Math.floor(Date.now() / 1000);
    const daysToAdd = PLAN_DAYS[plan];
    const newExpiration = now + daysToAdd * 86400;

    const before = await pool.query('SELECT payment_status FROM email_authorizations WHERE email = $1', [email]);
    const wasPaid = before.rows[0]?.payment_status === 'paid';

    const result = await pool.query(
      `UPDATE email_authorizations 
       SET payment_status = 'paid', paid_at = $1, plan_type = $2, subscription_expires_at = $3
       WHERE email = $4 AND payment_status = 'unpaid'`,
      [now, plan, newExpiration, email]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'No unpaid record found' });

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
          await sendEmail({
            to: referrerEmail,
            subject: '[Mind Insurance] Your referred user paid, reward pending',
            text: `Your referred user ${email} purchased ${plan} plan, you will receive ${rewardYuan} CNY reward. Please wait for admin transfer.`
          });
        }
      }
    } else {
      console.log(`Admin reconfirm payment for ${email} (already paid)`);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/send-auth-code', verifyAdminToken, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Missing email' });
  const check = await pool.query('SELECT payment_status FROM email_authorizations WHERE email = $1', [email]);
  if (check.rows.length === 0) return res.status(404).json({ error: 'Email not found' });
  if (check.rows[0].payment_status !== 'paid') return res.status(403).json({ error: 'Payment not confirmed yet' });
  const result = await pool.query(
    'SELECT auth_code FROM email_authorizations WHERE email = $1 AND authorized = false AND expires_at > $2',
    [email, Math.floor(Date.now() / 1000)]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'No valid pending record' });
  const authCode = result.rows[0].auth_code;
  const success = await sendEmail({ to: email, subject: '[Mind Insurance] Your Authorization Code', text: `Your authorization code is: ${authCode}\nValid for 24 hours.` });
  if (success) res.json({ success: true });
  else res.status(500).json({ error: 'Email send failed' });
});

app.post('/api/admin/mark-commission-paid', verifyAdminToken, async (req, res) => {
  const { commission_id } = req.body;
  if (!commission_id) return res.status(400).json({ error: 'Missing commission ID' });
  try {
    const now = Math.floor(Date.now() / 1000);
    const commission = await pool.query('SELECT referrer_email, amount, status FROM commissions WHERE id = $1', [commission_id]);
    if (commission.rows.length === 0) return res.status(404).json({ error: 'Commission not found' });
    if (commission.rows[0].status !== 'pending') return res.status(400).json({ error: 'Already processed' });
    const { referrer_email, amount } = commission.rows[0];
    await pool.query('BEGIN');
    await pool.query('UPDATE commissions SET status = $1, paid_at = $2 WHERE id = $3', ['paid', now, commission_id]);
    await pool.query('UPDATE email_authorizations SET commission_balance = commission_balance - $1 WHERE email = $2 AND commission_balance >= $1', [amount, referrer_email]);
    await pool.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/disable-email', verifyAdminToken, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Missing email' });
  await pool.query('UPDATE email_authorizations SET status = $1 WHERE email = $2', ['disabled', email]);
  res.json({ success: true });
});

app.post('/api/admin/enable-email', verifyAdminToken, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Missing email' });
  await pool.query('UPDATE email_authorizations SET status = $1 WHERE email = $2', ['active', email]);
  res.json({ success: true });
});

app.post('/api/admin/delete-email', verifyAdminToken, requireSuperAdmin, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Missing email' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const commissions = await client.query('SELECT id, referrer_email, amount FROM commissions WHERE user_email = $1', [email]);
    for (const row of commissions.rows) {
      const { referrer_email, amount } = row;
      await client.query('UPDATE email_authorizations SET commission_balance = GREATEST(commission_balance - $1, 0) WHERE email = $2', [amount, referrer_email]);
    }
    await client.query('DELETE FROM commissions WHERE referrer_email = $1 OR user_email = $1', [email]);
    await client.query('DELETE FROM tasks WHERE user_email = $1', [email]);
    await client.query('DELETE FROM payments WHERE user_email = $1', [email]);
    await client.query('DELETE FROM email_authorizations WHERE email = $1', [email]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Delete email error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/admin/update-expiration', verifyAdminToken, async (req, res) => {
  const { email, add_days, new_expiration_timestamp } = req.body;
  if (!email) return res.status(400).json({ error: 'Missing email' });
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
      return res.status(400).json({ error: 'Provide add_days or new_expiration_timestamp' });
    }
    await pool.query('UPDATE email_authorizations SET subscription_expires_at = $1 WHERE email = $2', [finalExpiration, email]);
    res.json({ success: true, new_expiration: finalExpiration });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/trigger-check', verifyAdminToken, async (req, res) => {
  console.log(`🔧 Manual trigger task check`);
  try {
    let offset = 0;
    const limit = 1000;
    let hasMore = true;
    let total = 0;
    while (hasMore) {
      const { rows: tasks } = await pool.query('SELECT * FROM tasks ORDER BY id LIMIT $1 OFFSET $2', [limit, offset]);
      for (const task of tasks) await checkTask(task);
      total += tasks.length;
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
      const success = await sendEmail({
        to: task.warningEmail,
        subject: '[Mind Insurance] Check-in Warning',
        text: task.warningMessage || `You have missed check-ins for ${overdueDays} day(s). Please check in.`
      });
      if (success) await pool.query('UPDATE tasks SET "warningSent" = 1, "warningTriggeredAt" = $1 WHERE id = $2', [now, task.id]);
    }
    return;
  }
  if (overdueDays >= warningDays + finalDays) {
    if (task.needHumanConfirm) {
      if (!task.customerNotified) {
        const customerEmail = process.env.SMTP_USER;
        const contactPhone = task.contactPhone || 'Not provided';
        const confirmLink = `${process.env.BASE_URL}/admin.html?token=${process.env.CUSTOMER_TOKEN || ''}`;
        const mailText = `Task "${task.name}" has reached termination and needs human confirmation.\n- User email: ${task.user_email}\n- Supervisor email: ${task.finalEmail}\n- Contact phone: ${contactPhone}\n- Last check-in: ${new Date(task.lastCheckin * 1000).toLocaleString()}\nPlease handle via admin panel: ${confirmLink}`;
        const success = await sendEmail({ to: customerEmail, subject: '[Mind Insurance] Customer support needed', text: mailText });
        if (success) await pool.query('UPDATE tasks SET "customerNotified" = 1 WHERE id = $1', [task.id]);
      }
    } else {
      if (!task.finalSent) {
        const baseText = task.finalMessage || `You have missed check-ins for ${overdueDays} day(s). Your task is terminated.`;
        const finalMailText = `Termination notice from ${task.user_email}:\n\n${baseText}`;
        const success = await sendEmail({ to: task.finalEmail, subject: '[Mind Insurance] Task Termination Notice', text: finalMailText });
        if (success) await pool.query('UPDATE tasks SET "finalSent" = 1 WHERE id = $1', [task.id]);
      }
    }
  }
}

app.use((err, req, res, next) => {
  console.error('Global error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${port}`);
  console.log(`📌 Plan prices: 1Y ${PLAN_PRICES['1y']/100} CNY, 2Y ${PLAN_PRICES['2y']/100} CNY, 3Y ${PLAN_PRICES['3y']/100} CNY`);
  console.log(`🎁 Rewards: 1Y ${PLAN_REWARDS['1y']/100} CNY, 2Y ${PLAN_REWARDS['2y']/100} CNY, 3Y ${PLAN_REWARDS['3y']/100} CNY`);
  if (TEST_EMAIL && TEST_CODE) console.log(`🔧 Test mode: ${TEST_EMAIL} / ${TEST_CODE}`);
  pool.query('SELECT NOW()', (err, dbRes) => {
    if (err) console.error('❌ Database connection failed', err.message);
    else console.log('✅ Database connected');
  });
});