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

// 静态文件服务：提供 public 文件夹下的所有文件（必须在路由之前）
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
        code_expires BIGINT
      )
    `);

    // 添加任务表的缺失字段（人工确认相关）
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

  // ---------- 路由定义（按顺序：API 优先，特殊页面其次，通配最后）----------

  // ========== 1. API 路由（所有 /api 开头的请求） ==========

  // 手工触发定时任务检查（已添加鉴权，需在请求时加上 ?token=你的CUSTOMER_TOKEN）
  app.post('/api/trigger-check', async (req, res) => {
    // 增加 token 验证，防止被恶意调用
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
          console.error(`检查任务 ${task.id} 失败:`, err);
        }
      }
      res.json({ success: true, message: '手工检查完成', result });
    } catch (err) {
      console.error('手工触发检查失败:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 发送登录验证码（已授权用户）或处理授权请求
  app.post('/api/send-login-code', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: '邮箱不能为空' });

    try {
      // 检查邮箱是否已授权
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

      // 未授权：检查是否有未过期的授权记录
      const now = Date.now();
      const existing = await pool.query(
        'SELECT auth_code, expires_at FROM email_authorizations WHERE email = $1 AND authorized = false',
        [email]
      );

      if (existing.rows.length > 0) {
        const record = existing.rows[0];
        if (record.expires_at > now) {
          // 未过期，不重新生成
          return res.status(403).json({ error: 'NEED_AUTHORIZATION', message: '您的邮箱正在等待授权，请等待授权码！' });
        } else {
          // 已过期，删除旧记录
          await pool.query('DELETE FROM email_authorizations WHERE email = $1', [email]);
        }
      }

      // 生成新授权码，有效期24小时
      const authCode = generateCode();
      const expiresAt = now + 24 * 60 * 60 * 1000;
      await pool.query(
        'INSERT INTO email_authorizations (email, auth_code, expires_at, authorized, created_at) VALUES ($1, $2, $3, $4, $5)',
        [email, authCode, expiresAt, false, now]
      );

      // 发送通知给管理员
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
      console.error('发送验证码出错:', err);
      res.status(500).json({ error: '服务器错误' });
    }
  });

  // 验证登录码（支持已授权用户的验证码和首次用户的授权码）
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

  // 获取当前用户的所有任务（已启用 token 鉴权）
  app.get('/api/tasks', async (req, res) => {
    const email = req.query.email;
    const { token } = req.query;
    if (!email) return res.status(400).json({ error: '缺少 email 参数' });
    
    // 启用 token 验证
    if (token !== process.env.CUSTOMER_TOKEN) {
      return res.status(403).json({ error: '无权访问' });
    }

    try {
      const { rows } = await pool.query('SELECT * FROM tasks WHERE user_email = $1', [email]);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 创建新任务
  app.post('/api/tasks', async (req, res) => {
    const task = req.body;
    if (!task.user_email) return res.status(400).json({ error: '缺少 user_email' });
    const now = Date.now();
    const newTask = {
      id: task.id || `task_${now}_${Math.random().toString(36).substr(2, 4)}`,
      user_email: task.user_email,
      name: task.name,
      cycleDays: task.cycleDays,
      warningDays: task.warningDays,
      finalDays: task.finalDays,
      warningEmail: task.warningEmail,
      finalEmail: task.finalEmail,
      warningMessage: task.warningMessage,
      finalMessage: task.finalMessage,
      lastCheckin: task.lastCheckin || now,
      created: now,
      warningSent: 0,
      finalSent: 0,
      warningTriggeredAt: null,
      needHumanConfirm: task.needHumanConfirm ? 1 : 0,
      contactPhone: task.contactPhone || null,
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
      res.json(newTask);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 更新任务
  app.put('/api/tasks/:id', async (req, res) => {
    const { id } = req.params;
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: '缺少 email 参数' });
    const updates = req.body;
    delete updates.user_email;
    delete updates.warningEmail;

    const setClause = Object.keys(updates).map((key, index) => `"${key}" = $${index + 1}`).join(', ');
    const values = Object.values(updates);
    values.push(id, email);

    try {
      const result = await pool.query(
        `UPDATE tasks SET ${setClause} WHERE id = $${values.length - 1} AND user_email = $${values.length}`,
        values
      );
      if (result.rowCount === 0) return res.status(404).json({ error: '任务不存在或无权操作' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 删除任务
  app.delete('/api/tasks/:id', async (req, res) => {
    const { id } = req.params;
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: '缺少 email 参数' });
    try {
      const result = await pool.query('DELETE FROM tasks WHERE id = $1 AND user_email = $2', [id, email]);
      if (result.rowCount === 0) return res.status(404).json({ error: '任务不存在或无权操作' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 手动打卡
  app.post('/api/tasks/:id/checkin', async (req, res) => {
    const { id } = req.params;
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: '缺少 email 参数' });
    const now = Date.now();
    try {
      const result = await pool.query(
        `UPDATE tasks SET "lastCheckin" = $1, "warningSent" = 0, "finalSent" = 0, "warningTriggeredAt" = NULL, "customerNotified" = 0
         WHERE id = $2 AND user_email = $3`,
        [now, id, email]
      );
      if (result.rowCount === 0) return res.status(404).json({ error: '任务不存在或无权操作' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 自动打卡（每天首次）
  app.post('/api/auto-checkin', async (req, res) => {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: '缺少 email 参数' });
    const now = Date.now();
    try {
      const result = await pool.query(
        `UPDATE tasks SET "lastCheckin" = $1, "warningSent" = 0, "finalSent" = 0, "warningTriggeredAt" = NULL, "customerNotified" = 0 WHERE user_email = $2`,
        [now, email]
      );
      console.log(`用户 ${email} 自动打卡成功，更新了 ${result.rowCount} 个任务`);
      res.json({ success: true, message: '自动打卡成功' });
    } catch (err) {
      console.error('自动打卡失败:', err);
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

  // 客服接口：手动发送终止通知
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
      const success = await sendMail({
        to: task.finalEmail,
        subject: '【心灵保险】任务终止通知',
        text: task.finalMessage || `您已连续多日未打卡，任务已终止。`
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

  // ========== 2. 特殊页面路由 ==========

  // 客服管理界面
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
          <details>
              <summary>待人工确认的任务</summary>
              <div id="taskList">加载中...</div>
          </details>
          <details>
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

  // ========== 3. 通配路由：所有未匹配的请求返回 index.html（必须放在最后）==========
  app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // ---------- 定时任务：每天上午9点运行一次（UTC 1:00）----------
  cron.schedule('0 1 * * *', async () => {
    console.log(`⏰ 定时任务触发：${new Date().toISOString()}`);
    try {
      const { rows: tasks } = await pool.query('SELECT * FROM tasks');
      for (const task of tasks) {
        await checkTask(task);
      }
    } catch (err) {
      console.error('定时任务执行失败', err);
    }
  });

  // ---------- 核心函数：检查单个任务状态并处理邮件（含人工确认逻辑）----------
  async function checkTask(task) {
    const now = Date.now();
    const diffMs = now - task.lastCheckin;
    const daysSince = Math.floor(diffMs / (24 * 60 * 60 * 1000));

    const cycleDays = task.cycleDays;
    const warningDays = task.warningDays;
    const finalDays = task.finalDays;

    if (daysSince <= cycleDays) return;

    const overdueDays = daysSince - cycleDays;

    // 警告状态
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

    // 终止状态
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
          const success = await sendMail({
            to: task.finalEmail,
            subject: '【心灵保险】任务终止通知',
            text: task.finalMessage || `您已连续 ${overdueDays} 天未打卡，任务已终止。`
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

  // ---------- 启动服务器 ----------
  app.listen(port, '0.0.0.0', () => {
    console.log(`后端服务运行在端口 ${port}（邮件功能${smtpReady ? '已启用' : '不可用'}）`);
    pool.query('SELECT NOW()', (err, dbRes) => {
      if (err) console.error('❌ PostgreSQL 连接失败', err.message);
      else console.log('✅ 成功连接到 PostgreSQL，服务器时间：', dbRes.rows[0].now);
    });
  });
}

// 执行启动函数
startServer().catch(err => {
  console.error('服务器启动失败:', err);
  process.exit(1);
});