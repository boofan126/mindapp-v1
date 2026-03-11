require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const dns = require('dns');
const { promisify } = require('util');
const path = require('path');

const resolve4 = promisify(dns.resolve4);

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ---------- 连接 PostgreSQL ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ---------- 初始化数据库表（增加人工确认和邮箱授权相关字段）----------
async function initDB() {
  const client = await pool.connect();
  try {
    // 创建任务表（如果不存在）
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
        verification_code TEXT,
        code_expires BIGINT,
        "needHumanConfirm" INTEGER DEFAULT 0,
        "contactPhone" TEXT,
        "customerNotified" INTEGER DEFAULT 0
      )
    `);

    // 添加任务表的缺失字段
    await client.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "needHumanConfirm" INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "contactPhone" TEXT`);
    await client.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "customerNotified" INTEGER DEFAULT 0`);

    // 新增邮箱授权表
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_authorizations (
        email TEXT PRIMARY KEY,
        auth_code TEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        authorized BOOLEAN DEFAULT FALSE,
        created_at BIGINT NOT NULL
      )
    `);

    console.log('数据库初始化完成');
  } catch (err) {
    console.error('数据库初始化失败', err);
  } finally {
    client.release();
  }
}
initDB();

// ---------- 内存存储验证码（用于已授权用户的登录验证码）----------
const verificationCodes = new Map();

// ---------- 辅助函数：生成随机6位数字码 ----------
function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ---------- 全局 transporter（稍后初始化）----------
let transporter = null;

// ---------- 异步启动服务器，先解析 SMTP IP ----------
async function startServer() {
  let smtpReady = false;
  try {
    const addresses = await resolve4('smtp.qq.com');
    const smtpIp = addresses[0];
    console.log('SMTP IP resolved:', smtpIp);

    transporter = nodemailer.createTransport({
      host: smtpIp,
      port: 587,
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      },
      tls: { rejectUnauthorized: false },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000
    });

    await transporter.verify();
    console.log('SMTP 服务器已就绪（IPv4 + 587）');
    smtpReady = true;
  } catch (err) {
    console.error('SMTP 初始化失败（IPv4 + 587）:', err.message);
    console.log('尝试降级使用域名 + 587 端口...');
    try {
      transporter = nodemailer.createTransport({
        host: 'smtp.qq.com',
        port: 587,
        secure: false,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        },
        tls: { rejectUnauthorized: false },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000
      });
      await transporter.verify();
      console.log('SMTP 服务器已就绪（域名 + 587）');
      smtpReady = true;
    } catch (err2) {
      console.error('SMTP 降级也失败，邮件功能将不可用', err2.message);
    }
  }

  // ---------- 通用邮件发送函数 ----------
  async function sendMail({ to, subject, html, text }) {
    if (!transporter) {
      console.error('邮件发送失败: transporter 未初始化');
      return false;
    }
    const mailOptions = {
      from: `"心灵保险" <${process.env.SMTP_USER}>`,
      to,
      subject,
      ...(html ? { html } : { text })
    };
    try {
      await transporter.sendMail(mailOptions);
      console.log(`邮件发送成功: ${to}`);
      return true;
    } catch (error) {
      console.error('邮件发送失败:', error);
      return false;
    }
  }

  // ---------- 发送登录验证码（已授权用户）或处理授权请求 ----------
  app.post('/api/send-login-code', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: '邮箱不能为空' });

    try {
      // 1. 检查邮箱是否已授权
      const authResult = await pool.query(
        'SELECT authorized FROM email_authorizations WHERE email = $1',
        [email]
      );

      if (authResult.rows.length > 0 && authResult.rows[0].authorized) {
        // 已授权，发送普通验证码
        const code = generateCode();
        const expires = Date.now() + 5 * 60 * 1000;
        verificationCodes.set(email, { code, expires });

        const success = await sendMail({
          to: email,
          subject: '【心灵保险】登录验证码',
          text: `您的登录验证码是：${code}，有效期5分钟。`
        });

        if (success) {
          res.json({ success: true, message: '验证码已发送' });
        } else {
          verificationCodes.delete(email);
          res.status(500).json({ error: '验证码发送失败，请稍后重试' });
        }
        return;
      }

      // 2. 未授权：检查是否有未过期的授权记录
      const now = Date.now();
      const existing = await pool.query(
        'SELECT auth_code, expires_at FROM email_authorizations WHERE email = $1 AND authorized = false',
        [email]
      );

      if (existing.rows.length > 0) {
        const record = existing.rows[0];
        if (record.expires_at > now) {
          // 未过期，不重新生成，仅提示等待
          return res.status(403).json({ error: 'NEED_AUTHORIZATION', message: '您的邮箱正在等待授权，请等待授权码！' });
        } else {
          // 已过期，删除旧记录，重新生成
          await pool.query('DELETE FROM email_authorizations WHERE email = $1', [email]);
        }
      }

      // 3. 生成新授权码，有效期24小时
      const authCode = generateCode();
      const expiresAt = now + 24 * 60 * 60 * 1000;
      await pool.query(
        'INSERT INTO email_authorizations (email, auth_code, expires_at, authorized, created_at) VALUES ($1, $2, $3, $4, $5)',
        [email, authCode, expiresAt, false, now]
      );

      // 4. 发送通知给管理员（SMTP_USER）
      const adminEmail = process.env.SMTP_USER;
      const adminLink = `${process.env.BASE_URL}/admin?token=${process.env.CUSTOMER_TOKEN}`;
      await sendMail({
        to: adminEmail,
        subject: '【心灵保险】新邮箱待授权',
        text: `
          用户邮箱：${email}
          授权码：${authCode}
          有效期至：${new Date(expiresAt).toLocaleString()}
          请登录后台手动发送此授权码给用户：${adminLink}
        `
      });

      // 返回前端需要等待的提示
      res.status(403).json({ error: 'NEED_AUTHORIZATION', message: '您的邮箱正在等待授权，请等待授权码！' });
    } catch (err) {
      console.error('发送验证码出错:', err);
      res.status(500).json({ error: '服务器错误' });
    }
  });

  // ---------- 验证登录码（支持两种：已授权用户的验证码 和 首次用户的授权码）----------
  app.post('/api/verify-login-code', async (req, res) => {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: '邮箱和验证码不能为空' });

    try {
      // 先检查邮箱是否已授权
      const authResult = await pool.query(
        'SELECT authorized FROM email_authorizations WHERE email = $1',
        [email]
      );

      if (authResult.rows.length > 0 && authResult.rows[0].authorized) {
        // 已授权用户：验证普通验证码
        const record = verificationCodes.get(email);
        if (!record) return res.status(400).json({ error: '请先获取验证码' });
        if (Date.now() > record.expires) {
          verificationCodes.delete(email);
          return res.status(400).json({ error: '验证码已过期，请重新获取' });
        }
        if (record.code !== code) return res.status(400).json({ error: '验证码错误' });

        verificationCodes.delete(email);
        return res.json({ success: true, message: '验证成功' });
      }

      // 未授权用户：验证授权码
      const pending = await pool.query(
        'SELECT auth_code, expires_at FROM email_authorizations WHERE email = $1 AND authorized = false',
        [email]
      );

      if (pending.rows.length === 0) {
        return res.status(400).json({ error: '该邮箱无待处理的授权请求，请先获取验证码' });
      }

      const record = pending.rows[0];
      if (Date.now() > record.expires_at) {
        return res.status(400).json({ error: '授权码已过期，请重新获取验证码' });
      }
      if (record.auth_code !== code) {
        return res.status(400).json({ error: '授权码错误' });
      }

      // 授权成功，标记为已授权
      await pool.query(
        'UPDATE email_authorizations SET authorized = true WHERE email = $1',
        [email]
      );

      res.json({ success: true, message: '授权成功，欢迎使用！' });
    } catch (err) {
      console.error('验证登录码出错:', err);
      res.status(500).json({ error: '服务器错误' });
    }
  });

  // ---------- 以下为原有任务相关路由（保持不变）----------
  // （由于篇幅，省略了任务相关的所有路由，它们与之前完全相同）
  // 请将您现有的任务路由完整复制在此处
  // 包括 /api/tasks GET/POST, /api/tasks/:id PUT/DELETE, /api/tasks/:id/checkin, /api/auto-checkin,
  // /api/customer/pending-tasks, /api/customer/send-final/:taskId, /admin 等

  // 示例：需要保留所有任务路由（此处省略，但实际代码必须完整包含）

  // ---------- 新增管理员接口：获取待授权邮箱列表 ----------
  app.get('/api/admin/pending-auths', async (req, res) => {
    const token = req.query.token;
    if (token !== process.env.CUSTOMER_TOKEN) {
      return res.status(403).json({ error: '无权访问' });
    }
    try {
      const now = Date.now();
      const { rows } = await pool.query(
        `SELECT email, auth_code, created_at, expires_at
         FROM email_authorizations
         WHERE authorized = false AND expires_at > $1
         ORDER BY created_at DESC`,
        [now]
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 新增管理员接口：手动发送授权码到用户邮箱
  app.post('/api/admin/send-auth-code', async (req, res) => {
    const token = req.query.token;
    if (token !== process.env.CUSTOMER_TOKEN) {
      return res.status(403).json({ error: '无权访问' });
    }
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: '缺少邮箱' });

    try {
      const result = await pool.query(
        'SELECT auth_code FROM email_authorizations WHERE email = $1 AND authorized = false AND expires_at > $2',
        [email, Date.now()]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: '无有效的待授权记录' });
      }
      const authCode = result.rows[0].auth_code;

      const success = await sendMail({
        to: email,
        subject: '【心灵保险】您的邮箱授权码',
        text: `您的邮箱授权码是：${authCode}，有效期24小时。请在登录页面输入该授权码完成验证。`
      });

      if (success) {
        res.json({ success: true, message: '授权码已发送' });
      } else {
        res.status(500).json({ error: '邮件发送失败' });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 健康检查
  app.get('/health', (req, res) => {
    res.status(200).send('OK');
  });

  // 通配路由返回 index.html（支持前端路由）
  app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // 启动服务器
  app.listen(port, '0.0.0.0', () => {
    console.log(`后端服务运行在端口 ${port}（邮件功能${smtpReady ? '已启用' : '不可用'}）`);
    pool.query('SELECT NOW()', (err, dbRes) => {
      if (err) console.error('❌ PostgreSQL 连接失败', err.message);
      else console.log('✅ 成功连接到 PostgreSQL，服务器时间：', dbRes.rows[0].now);
    });
  });
}

startServer().catch(err => {
  console.error('服务器启动失败:', err);
  process.exit(1);
});