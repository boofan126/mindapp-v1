require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const cron = require('node-cron');
const nodemailer = require('nodemailer');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ---------- 连接 PostgreSQL ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ---------- 初始化数据库表（增加人工确认相关字段）----------
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
        "needHumanConfirm" INTEGER DEFAULT 0,   -- 新增：是否需要人工确认（0=否，1=是）
        "contactPhone" TEXT,                     -- 新增：联系电话
        "customerNotified" INTEGER DEFAULT 0     -- 新增：是否已通知客服
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

// ---------- 配置 Nodemailer 发件器（使用 QQ 邮箱）----------
const transporter = nodemailer.createTransport({
  host: 'smtp.qq.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.SMTP_USER,      // 你的 QQ 邮箱
    pass: process.env.SMTP_PASS        // 你的 QQ 邮箱授权码
  }
});

// 验证 SMTP 连接
transporter.verify((error, success) => {
  if (error) {
    console.error('SMTP 连接失败:', error);
  } else {
    console.log('SMTP 服务器已就绪');
  }
});

// ---------- 内存存储验证码（邮箱 -> { code, expires }）----------
const verificationCodes = new Map();

// ---------- 辅助函数：生成随机验证码 ----------
function generateVerificationCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ---------- 通用邮件发送函数（使用 Nodemailer）----------
async function sendMail({ to, subject, html, text }) {
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

// ---------- 发送登录验证码 ----------
app.post('/api/send-login-code', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: '邮箱不能为空' });

  const code = generateVerificationCode();
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
});

// ---------- 验证登录验证码 ----------
app.post('/api/verify-login-code', (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: '邮箱和验证码不能为空' });

  const record = verificationCodes.get(email);
  if (!record) return res.status(400).json({ error: '请先获取验证码' });
  if (Date.now() > record.expires) {
    verificationCodes.delete(email);
    return res.status(400).json({ error: '验证码已过期，请重新获取' });
  }
  if (record.code !== code) return res.status(400).json({ error: '验证码错误' });

  verificationCodes.delete(email);
  res.json({ success: true, message: '验证成功' });
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

  // 警告状态（始终自动发送）
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

  // 终止状态（根据是否需要人工确认分支）
  if (overdueDays >= warningDays + finalDays) {
    // 如果任务需要人工确认
    if (task.needHumanConfirm) {
      // 尚未通知客服则发送客服通知邮件
      if (!task.customerNotified) {
        // 构建客服邮件内容（客服邮箱设为系统发件邮箱，或指定客服邮箱）
        const customerEmail = process.env.SMTP_USER; // 这里使用发件邮箱作为客服邮箱
        const contactPhone = task.contactPhone || '未提供';
        const mailContent = `
          任务 "${task.name}" 已到达终止条件，需要人工确认。
          - 用户邮箱：${task.user_email}
          - 监督人邮箱：${task.finalEmail}
          - 联系电话：${contactPhone}
          - 任务详情：周期 ${cycleDays} 天，警告 ${warningDays} 天，终止 ${finalDays} 天
          - 最后打卡时间：${new Date(task.lastCheckin).toLocaleString()}
          请尽快联系用户确认，确认后访问以下链接手动发送终止通知：
          ${process.env.BASE_URL}/api/customer/send-final/${task.id}  (需 POST 请求)
        `;
        const success = await sendMail({
          to: customerEmail,
          subject: '【心灵保险】客服人工确认提醒',
          text: mailContent
        });
        if (success) {
          await pool.query(
            'UPDATE tasks SET "customerNotified" = 1 WHERE id = $1',
            [task.id]
          );
        }
      }
      // 客服通知后，不发送终止邮件，等待客服手动触发
      return;
    } else {
      // 无需人工确认，直接发送终止邮件
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

// ---------- API 路由 ----------

// 获取当前用户的所有任务
app.get('/api/tasks', async (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: '缺少 email 参数' });
  try {
    const { rows } = await pool.query('SELECT * FROM tasks WHERE user_email = $1', [email]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 创建新任务（支持人工确认字段）
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

// 更新任务（支持人工确认字段）
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

// ---------- 新增：自动打卡（每天首次，为当前用户所有任务打卡）----------
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

// ---------- 客服接口：获取待确认任务列表（需简单鉴权，使用固定 token）----------
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

// ---------- 健康检查 ----------
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// ---------- 客服管理界面（简单 HTML）----------
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
        </style>
    </head>
    <body>
        <h1>待人工确认的任务</h1>
        <div id="taskList">加载中...</div>
        <script>
            const token = new URLSearchParams(location.search).get('token');
            async function loadTasks() {
                const res = await fetch('/api/customer/pending-tasks?token=' + token);
                if (!res.ok) {
                    document.getElementById('taskList').innerHTML = '加载失败';
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
                    \`);
                });
                document.getElementById('taskList').innerHTML = html;
            }
            async function sendFinal(taskId) {
                if (!confirm('确认已联系用户并发送终止通知？')) return;
                const res = await fetch('/api/customer/send-final/' + taskId + '?token=' + token, { method: 'POST' });
                const result = await res.json();
                if (res.ok) {
                    alert('发送成功');
                    document.getElementById('task-' + taskId).remove();
                } else {
                    alert('发送失败：' + (result.error || '未知错误'));
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
            loadTasks();
        </script>
    </body>
    </html>
  `);
});

// 启动服务器
app.listen(port, '0.0.0.0', () => {
  console.log(`后端服务运行在端口 ${port}`);
  // 验证数据库连接
  pool.query('SELECT NOW()', (err, res) => {
    if (err) console.error('❌ PostgreSQL 连接失败', err.message);
    else console.log('✅ 成功连接到 PostgreSQL，服务器时间：', res.rows[0].now);
  });
});