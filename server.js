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
app.use(express.static(path.join(__dirname, 'public')));

// ---------- PostgreSQL 连接（使用 Render 提供的 DATABASE_URL）----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ---------- 初始化数据库表 ----------
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
        verification_code TEXT,
        code_expires BIGINT,
        "needHumanConfirm" INTEGER DEFAULT 0,
        "contactPhone" TEXT,
        "customerNotified" INTEGER DEFAULT 0
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS email_authorizations (
        email TEXT PRIMARY KEY,
        auth_code TEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        authorized BOOLEAN DEFAULT FALSE,
        created_at BIGINT NOT NULL
      )
    `);

    console.log('✅ 数据库初始化完成');
  } catch (err) {
    console.error('❌ 数据库初始化失败', err);
  } finally {
    client.release();
  }
}
initDB();

// ---------- 内存存储验证码 ----------
const verificationCodes = new Map();

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ---------- SMTP 邮件发送（使用 QQ 邮箱，适配 Render 付费实例）----------
let transporter = null;

async function startServer() {
  let smtpReady = false;
  try {
    const smtpHost = process.env.SMTP_HOST || 'smtp.qq.com';
    const smtpPort = parseInt(process.env.SMTP_PORT) || 465;
    const addresses = await resolve4(smtpHost);
    const smtpIp = addresses[0];
    console.log('📧 SMTP IP 解析:', smtpIp);

    transporter = nodemailer.createTransport({
      host: smtpIp,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      },
      tls: { rejectUnauthorized: false },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000
    });

    await transporter.verify();
    console.log(`✅ SMTP 服务器就绪（端口 ${smtpPort}）`);
    smtpReady = true;
  } catch (err) {
    console.error('❌ SMTP 初始化失败:', err.message);
    console.log('🔄 尝试使用域名直连...');
    try {
      const smtpHost = process.env.SMTP_HOST || 'smtp.qq.com';
      const smtpPort = parseInt(process.env.SMTP_PORT) || 465;
      transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        },
        tls: { rejectUnauthorized: false },
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 20000
      });
      await transporter.verify();
      console.log(`✅ SMTP 服务器就绪（域名直连，端口 ${smtpPort}）`);
      smtpReady = true;
    } catch (err2) {
      console.error('❌ SMTP 降级连接也失败，邮件功能不可用', err2.message);
    }
  }

  async function sendMail({ to, subject, html, text }) {
    if (!transporter) return false;
    try {
      await transporter.sendMail({
        from: `"心灵保险" <${process.env.SMTP_USER}>`,
        to,
        subject,
        ...(html ? { html } : { text })
      });
      console.log(`📧 邮件发送成功: ${to}`);
      return true;
    } catch (error) {
      console.error('📧 邮件发送失败:', error);
      return false;
    }
  }

  // ========== API 路由 ==========
  // 发送登录验证码/授权请求
  app.post('/api/send-login-code', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: '邮箱不能为空' });

    try {
      const authResult = await pool.query(
        'SELECT authorized FROM email_authorizations WHERE email = $1',
        [email]
      );

      if (authResult.rows.length > 0 && authResult.rows[0].authorized) {
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

      const now = Date.now();
      const existing = await pool.query(
        'SELECT auth_code, expires_at FROM email_authorizations WHERE email = $1 AND authorized = false',
        [email]
      );

      if (existing.rows.length > 0) {
        const record = existing.rows[0];
        if (record.expires_at > now) {
          return res.status(403).json({ error: 'NEED_AUTHORIZATION', message: '您的邮箱正在等待授权，请等待授权码！' });
        } else {
          await pool.query('DELETE FROM email_authorizations WHERE email = $1', [email]);
        }
      }

      const authCode = generateCode();
      const expiresAt = now + 24 * 60 * 60 * 1000;
      await pool.query(
        'INSERT INTO email_authorizations (email, auth_code, expires_at, authorized, created_at) VALUES ($1, $2, $3, $4, $5)',
        [email, authCode, expiresAt, false, now]
      );

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

      res.status(403).json({ error: 'NEED_AUTHORIZATION', message: '您的邮箱正在等待授权，请等待授权码！' });
    } catch (err) {
      console.error('🔴 发送验证码出错:', err);
      res.status(500).json({ error: '服务器错误' });
    }
  });

  // 验证登录码/授权码
  app.post('/api/verify-login-code', async (req, res) => {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: '邮箱和验证码不能为空' });

    try {
      const authResult = await pool.query(
        'SELECT authorized FROM email_authorizations WHERE email = $1',
        [email]
      );

      if (authResult.rows.length > 0 && authResult.rows[0].authorized) {
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

      await pool.query(
        'UPDATE email_authorizations SET authorized = true WHERE email = $1',
        [email]
      );

      res.json({ success: true, message: '授权成功，欢迎使用！' });
    } catch (err) {
      console.error('🔴 验证登录码出错:', err);
      res.status(500).json({ error: '服务器错误' });
    }
  });

  // 获取当前用户的所有任务（返回原始 lastCheckin 数字）
  app.get('/api/tasks', async (req, res) => {
    const token = req.query.token || req.headers['x-token'];
    if (token !== process.env.CUSTOMER_TOKEN) {
      return res.status(403).json({ error: '无权访问' });
    }

    const email = req.query.email || req.headers['x-user-email'];
    if (!email) return res.status(400).json({ error: '缺少用户标识' });

    try {
      const query = `
        SELECT 
          id, 
          name, 
          "cycleDays" as cycle_days, 
          "warningDays" as warning_days, 
          "finalDays" as final_days, 
          "warningEmail" as warning_email, 
          "finalEmail" as final_email, 
          "warningMessage" as warning_message, 
          "finalMessage" as final_message, 
          "lastCheckin" as last_checkin,
          "needHumanConfirm" as need_human_confirm, 
          "contactPhone" as contact_phone,
          "warningSent",
          "finalSent"
        FROM tasks 
        WHERE user_email = $1
      `;
      const { rows } = await pool.query(query, [email]);

      const tasks = rows.map(task => ({
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
        need_human_confirm: task.need_human_confirm === 1,
        contact_phone: task.contact_phone,
        status: task.finalSent ? 'final' : (task.warningSent ? 'warning' : 'normal')
      }));
      res.json(tasks);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 获取单个任务详情
  app.get('/api/tasks/:id', async (req, res) => {
    const token = req.query.token || req.headers['x-token'];
    if (token !== process.env.CUSTOMER_TOKEN) {
      return res.status(403).json({ error: '无权访问' });
    }

    const { id } = req.params;
    const email = req.query.email || req.headers['x-user-email'];
    if (!email) return res.status(400).json({ error: '缺少用户标识' });

    try {
      const query = `
        SELECT 
          id, 
          name, 
          "cycleDays" as cycle_days, 
          "warningDays" as warning_days, 
          "finalDays" as final_days, 
          "warningEmail" as warning_email, 
          "finalEmail" as final_email, 
          "warningMessage" as warning_message, 
          "finalMessage" as final_message, 
          "lastCheckin" as last_checkin,
          "needHumanConfirm" as need_human_confirm, 
          "contactPhone" as contact_phone,
          "warningSent",
          "finalSent"
        FROM tasks 
        WHERE id = $1 AND user_email = $2
      `;
      const { rows } = await pool.query(query, [id, email]);
      if (rows.length === 0) return res.status(404).json({ error: '任务不存在' });

      const task = rows[0];
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
        need_human_confirm: task.need_human_confirm === 1,
        contact_phone: task.contact_phone,
        status: task.finalSent ? 'final' : (task.warningSent ? 'warning' : 'normal')
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 创建新任务
  app.post('/api/tasks', async (req, res) => {
    const token = req.query.token || req.headers['x-token'];
    if (token !== process.env.CUSTOMER_TOKEN) {
      return res.status(403).json({ error: '无权访问' });
    }

    const task = req.body;
    if (!task.email) return res.status(400).json({ error: '缺少用户邮箱' });

    const now = Date.now();
    const newTask = {
      id: `task_${now}_${Math.random().toString(36).substr(2, 4)}`,
      user_email: task.email,
      name: task.name,
      cycleDays: task.cycle_days,
      warningDays: task.warning_days,
      finalDays: task.final_days,
      warningEmail: task.warning_email || task.email,
      finalEmail: task.final_email,
      warningMessage: task.warning_message,
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
        `INSERT INTO tasks (
          id, user_email, name, "cycleDays", "warningDays", "finalDays", 
          "warningEmail", "finalEmail", "warningMessage", "finalMessage", 
          "lastCheckin", created, "warningSent", "finalSent", "warningTriggeredAt",
          "needHumanConfirm", "contactPhone", "customerNotified"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        Object.values(newTask)
      );
      res.json({ success: true, id: newTask.id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 更新任务
  app.put('/api/tasks/:id', async (req, res) => {
    const token = req.query.token || req.headers['x-token'];
    if (token !== process.env.CUSTOMER_TOKEN) {
      return res.status(403).json({ error: '无权访问' });
    }

    const { id } = req.params;
    const email = req.body.email || req.headers['x-user-email'];
    const updates = req.body;
    if (!email) return res.status(400).json({ error: '缺少用户标识' });

    const setParts = [];
    const values = [];
    let index = 1;

    if (updates.name !== undefined) {
      setParts.push(`"name" = $${index++}`);
      values.push(updates.name);
    }
    if (updates.cycle_days !== undefined) {
      setParts.push(`"cycleDays" = $${index++}`);
      values.push(updates.cycle_days);
    }
    if (updates.warning_days !== undefined) {
      setParts.push(`"warningDays" = $${index++}`);
      values.push(updates.warning_days);
    }
    if (updates.final_days !== undefined) {
      setParts.push(`"finalDays" = $${index++}`);
      values.push(updates.final_days);
    }
    if (updates.final_email !== undefined) {
      setParts.push(`"finalEmail" = $${index++}`);
      values.push(updates.final_email);
    }
    if (updates.warning_message !== undefined) {
      setParts.push(`"warningMessage" = $${index++}`);
      values.push(updates.warning_message);
    }
    if (updates.final_message !== undefined) {
      setParts.push(`"finalMessage" = $${index++}`);
      values.push(updates.final_message);
    }
    if (updates.need_human_confirm !== undefined) {
      setParts.push(`"needHumanConfirm" = $${index++}`);
      values.push(updates.need_human_confirm ? 1 : 0);
    }
    if (updates.contact_phone !== undefined) {
      setParts.push(`"contactPhone" = $${index++}`);
      values.push(updates.contact_phone);
    }

    if (setParts.length === 0) {
      return res.status(400).json({ error: '没有要更新的字段' });
    }

    values.push(id, email);
    const query = `UPDATE tasks SET ${setParts.join(', ')} WHERE id = $${index++} AND user_email = $${index++}`;

    try {
      const result = await pool.query(query, values);
      if (result.rowCount === 0) return res.status(404).json({ error: '任务不存在或无权操作' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 删除任务
  app.delete('/api/tasks/:id', async (req, res) => {
    const token = req.query.token || req.headers['x-token'];
    if (token !== process.env.CUSTOMER_TOKEN) {
      return res.status(403).json({ error: '无权访问' });
    }

    const { id } = req.params;
    const email = req.query.email || req.headers['x-user-email'];
    if (!email) return res.status(400).json({ error: '缺少用户标识' });

    try {
      const result = await pool.query(
        'DELETE FROM tasks WHERE id = $1 AND user_email = $2',
        [id, email]
      );
      if (result.rowCount === 0) return res.status(404).json({ error: '任务不存在或无权操作' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 手动打卡
  app.post('/api/tasks/:id/checkin', async (req, res) => {
    const token = req.query.token || req.headers['x-token'];
    if (token !== process.env.CUSTOMER_TOKEN) {
      return res.status(403).json({ error: '无权访问' });
    }

    const { id } = req.params;
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: '缺少用户邮箱' });

    const now = Date.now();
    try {
      const result = await pool.query(
        `UPDATE tasks SET 
          "lastCheckin" = $1, 
          "warningSent" = 0, 
          "finalSent" = 0, 
          "warningTriggeredAt" = NULL, 
          "customerNotified" = 0
         WHERE id = $2 AND user_email = $3`,
        [now, id, email]
      );
      if (result.rowCount === 0) return res.status(404).json({ error: '任务不存在或无权操作' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 一键打卡所有任务（新增）
  app.post('/api/auto-checkin', async (req, res) => {
    const token = req.query.token || req.headers['x-token'];
    if (token !== process.env.CUSTOMER_TOKEN) {
      return res.status(403).json({ error: '无权访问' });
    }

    const { email } = req.body;
    if (!email) return res.status(400).json({ error: '缺少用户邮箱' });
    const now = Date.now();
    try {
      const result = await pool.query(
        `UPDATE tasks SET 
          "lastCheckin" = $1, 
          "warningSent" = 0, 
          "finalSent" = 0, 
          "warningTriggeredAt" = NULL, 
          "customerNotified" = 0 
         WHERE user_email = $2`,
        [now, email]
      );
      console.log(`🤖 用户 ${email} 一键打卡成功，更新了 ${result.rowCount} 个任务`);
      res.json({ success: true, count: result.rowCount });
    } catch (err) {
      console.error('🔴 一键打卡失败:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 保存联系电话（新增）
  app.post('/api/tasks/:id/phone', async (req, res) => {
    const token = req.query.token || req.headers['x-token'];
    if (token !== process.env.CUSTOMER_TOKEN) {
      return res.status(403).json({ error: '无权访问' });
    }

    const { id } = req.params;
    const { phone, email } = req.body;
    if (!email || !phone) return res.status(400).json({ error: '缺少必要参数' });

    try {
      await pool.query(
        'UPDATE tasks SET "contactPhone" = $1 WHERE id = $2 AND user_email = $3',
        [phone, id, email]
      );
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 客服接口：获取待确认任务列表
  app.get('/api/customer/pending-tasks', async (req, res) => {
    const token = req.query.token;
    if (token !== process.env.CUSTOMER_TOKEN) {
      return res.status(403).json({ error: '无权访问' });
    }
    try {
      const { rows } = await pool.query(
        `SELECT id, user_email, name, "finalEmail", "contactPhone", "lastCheckin"
         FROM tasks
         WHERE "needHumanConfirm" = 1 AND "finalSent" = 0 AND "customerNotified" = 1`
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 客服接口：手动发送终止通知（添加发送者前缀）
  app.post('/api/customer/send-final/:taskId', async (req, res) => {
    const token = req.query.token;
    if (token !== process.env.CUSTOMER_TOKEN) {
      return res.status(403).json({ error: '无权访问' });
    }
    const { taskId } = req.params;
    try {
      const { rows } = await pool.query('SELECT * FROM tasks WHERE id = $1', [taskId]);
      if (rows.length === 0) return res.status(404).json({ error: '任务不存在' });
      const task = rows[0];
      if (!task.needHumanConfirm || task.finalSent) {
        return res.status(400).json({ error: '该任务无需人工确认或已发送终止通知' });
      }
      const baseText = task.finalMessage || `您已连续多日未打卡，任务已终止。`;
      const mailText = `来自 ${task.user_email} 的终止通知：\n\n${baseText}`;
      const success = await sendMail({
        to: task.finalEmail,
        subject: '【心灵保险】任务终止通知',
        text: mailText
      });
      if (success) {
        await pool.query('UPDATE tasks SET "finalSent" = 1 WHERE id = $1', [taskId]);
        res.json({ success: true, message: '终止通知已发送' });
      } else {
        res.status(500).json({ error: '邮件发送失败' });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 管理员接口：获取待授权邮箱列表
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

  // 手工触发定时任务检查
  app.post('/api/trigger-check', async (req, res) => {
    const { token } = req.query;
    if (token !== process.env.CUSTOMER_TOKEN) {
      return res.status(403).json({ error: '无权访问' });
    }

    console.log(`🔧 手工触发定时任务检查：${new Date().toISOString()}`);
    try {
      const { rows: tasks } = await pool.query('SELECT * FROM tasks');
      let result = { total: tasks.length, processed: 0, errors: [] };
      for (const task of tasks) {
        try {
          await checkTask(task);
          result.processed++;
        } catch (err) {
          result.errors.push({ taskId: task.id, error: err.message });
        }
      }
      res.json({ success: true, message: '手工检查完成', result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 管理员接口：手动发送授权码到用户邮箱
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

  // ========== 特殊页面路由 ==========
  app.get('/admin', (req, res) => {
    const token = req.query.token;
    if (token !== process.env.CUSTOMER_TOKEN) {
      return res.status(403).send('无权访问');
    }
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
          <title>客服管理 - 待确认任务</title>
          <meta charset="UTF-8">
          <style>
              body { font-family: system-ui; padding: 20px; background: #f5f5f5; }
              .task { background: white; border-radius: 8px; padding: 15px; margin-bottom: 10px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
              .task p { margin: 5px 0; }
              button { padding: 8px 16px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; }
              button:disabled { background: #ccc; }
              details { margin: 10px 0; }
              summary { font-weight: bold; cursor: pointer; padding: 8px; background: #e9ecef; border-radius: 8px; }
              .auth-item { background: white; border: 1px solid #ddd; border-radius: 8px; padding: 10px; margin: 5px 0; display: flex; justify-content: space-between; align-items: center; }
              .auth-item button { padding: 5px 10px; font-size: 0.9rem; }
          </style>
      </head>
      <body>
          <h1>客服管理后台</h1>
          <details open>
              <summary>待人工确认的任务</summary>
              <div id="taskList">加载中...</div>
          </details>
          <details open>
              <summary>待授权邮箱</summary>
              <div id="authList">加载中...</div>
          </details>
          <script>
              const token = new URLSearchParams(location.search).get('token');
              if (!token) {
                  document.body.innerHTML = '<h2>缺少 token 参数</h2>';
              } else {
                  loadTasks();
                  loadAuths();
              }

              async function loadTasks() {
                  try {
                      const res = await fetch('/api/customer/pending-tasks?token=' + token);
                      if (!res.ok) {
                          const errorText = await res.text();
                          document.getElementById('taskList').innerHTML = '加载失败: ' + errorText;
                          return;
                      }
                      const tasks = await res.json();
                      if (tasks.length === 0) {
                          document.getElementById('taskList').innerHTML = '暂无待确认任务';
                          return;
                      }
                      let html = '';
                      tasks.forEach(task => {
                          html += \`
                              <div class="task" id="task-\${task.id}">
                                  <p><strong>\${escapeHtml(task.name)}</strong></p>
                                  <p>用户邮箱：\${escapeHtml(task.user_email)}</p>
                                  <p>监督人邮箱：\${escapeHtml(task.finalEmail)}</p>
                                  <p>联系电话：\${escapeHtml(task.contactPhone || '无')}</p>
                                  <p>最后打卡：\${new Date(task.lastCheckin).toLocaleString()}</p>
                                  <button onclick="sendFinal('\${task.id}')">确认发送终止通知</button>
                              </div>
                          \`;
                      });
                      document.getElementById('taskList').innerHTML = html;
                  } catch (err) {
                      document.getElementById('taskList').innerHTML = '加载异常: ' + err.message;
                  }
              }

              async function loadAuths() {
                  try {
                      const res = await fetch('/api/admin/pending-auths?token=' + token);
                      if (!res.ok) {
                          const errorText = await res.text();
                          document.getElementById('authList').innerHTML = '加载失败: ' + errorText;
                          return;
                      }
                      const auths = await res.json();
                      if (auths.length === 0) {
                          document.getElementById('authList').innerHTML = '暂无待授权邮箱';
                          return;
                      }
                      let html = '';
                      auths.forEach(item => {
                          html += \`
                              <div class="auth-item" id="auth-\${item.email}">
                                  <div>
                                      <strong>\${escapeHtml(item.email)}</strong><br>
                                      授权码：\${escapeHtml(item.auth_code)}<br>
                                      申请时间：\${new Date(item.created_at).toLocaleString()}<br>
                                      过期时间：\${new Date(item.expires_at).toLocaleString()}
                                  </div>
                                  <button onclick="sendAuthCode('\${item.email}')">发送授权码</button>
                              </div>
                          \`;
                      });
                      document.getElementById('authList').innerHTML = html;
                  } catch (err) {
                      document.getElementById('authList').innerHTML = '加载异常: ' + err.message;
                  }
              }

              async function sendFinal(taskId) {
                  if (!confirm('确认已联系用户并发送终止通知？')) return;
                  try {
                      const res = await fetch('/api/customer/send-final/' + taskId + '?token=' + token, { method: 'POST' });
                      const result = await res.json();
                      if (res.ok) {
                          alert('发送成功');
                          document.getElementById('task-' + taskId).remove();
                      } else {
                          alert('发送失败：' + (result.error || '未知错误'));
                      }
                  } catch (err) {
                      alert('请求异常：' + err.message);
                  }
              }

              async function sendAuthCode(email) {
                  if (!confirm('确认发送授权码到该邮箱？')) return;
                  try {
                      const res = await fetch('/api/admin/send-auth-code?token=' + token, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ email })
                      });
                      const result = await res.json();
                      if (res.ok) {
                          alert('授权码已发送');
                          document.getElementById('auth-' + email).remove();
                      } else {
                          alert('发送失败：' + (result.error || '未知错误'));
                      }
                  } catch (err) {
                      alert('请求异常：' + err.message);
                  }
              }

              function escapeHtml(text) {
                  if (!text) return '';
                  return String(text).replace(/[&<>"]/g, function(m) {
                      if (m === '&') return '&amp;';
                      if (m === '<') return '&lt;';
                      if (m === '>') return '&gt;';
                      if (m === '"') return '&quot;';
                      return m;
                  });
              }
          </script>
      </body>
      </html>
    `);
  });

  // 健康检查
  app.get('/health', (req, res) => {
    res.status(200).send('OK');
  });

  // 通配路由（必须放在最后）
  app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // ---------- 定时任务 ----------
  cron.schedule('0 1 * * *', async () => {
    console.log(`⏰ 定时任务触发：${new Date().toISOString()}`);
    try {
      const { rows: tasks } = await pool.query('SELECT * FROM tasks');
      for (const task of tasks) {
        await checkTask(task);
      }
    } catch (err) {
      console.error('🔴 定时任务执行失败', err);
    }
  });

  // ---------- 核心函数：检查单个任务状态（添加发送者前缀）----------
  async function checkTask(task) {
    const now = Date.now();
    const diffMs = now - task.lastCheckin;
    const daysSince = Math.floor(diffMs / (24 * 60 * 60 * 1000));

    const cycleDays = task.cycleDays;
    const warningDays = task.warningDays;
    const finalDays = task.finalDays;

    if (daysSince <= cycleDays) return;

    const overdueDays = daysSince - cycleDays;

    if (overdueDays >= warningDays && overdueDays < warningDays + finalDays) {
      if (!task.warningSent) {
        const success = await sendMail({
          to: task.warningEmail,
          subject: '【心灵保险】打卡警告',
          text: task.warningMessage || `您已连续 ${overdueDays} 天未打卡，请及时打卡。`
        });
        if (success) {
          await pool.query(
            'UPDATE tasks SET "warningSent" = 1, "warningTriggeredAt" = $1 WHERE id = $2',
            [now, task.id]
          );
        }
      }
      return;
    }

    if (overdueDays >= warningDays + finalDays) {
      if (task.needHumanConfirm) {
        if (!task.customerNotified) {
          const customerEmail = process.env.SMTP_USER;
          const contactPhone = task.contactPhone || '未提供';
          const confirmLink = `${process.env.BASE_URL}/admin?token=${process.env.CUSTOMER_TOKEN}`;
          const mailText = `
            任务 "${task.name}" 已到达终止条件，需要人工确认。
            - 用户邮箱：${task.user_email}
            - 监督人邮箱：${task.finalEmail}
            - 联系电话：${contactPhone}
            - 最后打卡：${new Date(task.lastCheckin).toLocaleString()}
            请登录客服界面处理：${confirmLink}
          `;
          const success = await sendMail({
            to: customerEmail,
            subject: '【心灵保险】客服人工确认提醒',
            text: mailText
          });
          if (success) {
            await pool.query(
              'UPDATE tasks SET "customerNotified" = 1 WHERE id = $1',
              [task.id]
            );
          }
        }
        return;
      } else {
        if (!task.finalSent) {
          const baseText = task.finalMessage || `您已连续 ${overdueDays} 天未打卡，任务已终止。`;
          const finalMailText = `来自 ${task.user_email} 的终止通知：\n\n${baseText}`;
          const success = await sendMail({
            to: task.finalEmail,
            subject: '【心灵保险】任务终止通知',
            text: finalMailText
          });
          if (success) {
            await pool.query(
              'UPDATE tasks SET "finalSent" = 1 WHERE id = $1',
              [task.id]
            );
          }
        }
      }
    }
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`✅ 后端服务运行在端口 ${port}（邮件功能${smtpReady ? '已启用' : '不可用'}）`);
    pool.query('SELECT NOW()', (err, dbRes) => {
      if (err) console.error('❌ 数据库连接失败', err.message);
      else console.log('✅ 数据库连接正常，时间：', dbRes.rows[0].now);
    });
  });
}

startServer().catch(err => {
  console.error('❌ 服务器启动失败:', err);
  process.exit(1);
});