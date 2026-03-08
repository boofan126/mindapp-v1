require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg'); // 引入 pg 库
const cron = require('node-cron');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ---------- 连接 PostgreSQL ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Render 强制 SSL
});

// 添加这一块来验证连接
pool.query('SELECT NOW() as pg_time', (err, res) => {
  if (err) {
    console.error('❌ PostgreSQL 连接失败，当前可能在使用 SQLite！错误信息：', err.message);
  } else {
    console.log('✅ 成功连接到 PostgreSQL，服务器时间：', res.rows[0].pg_time);
  }
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
        code_expires BIGINT
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

// ---------- 内存存储验证码（邮箱 -> { code, expires }）----------
const verificationCodes = new Map();

// ---------- 辅助函数：发送邮件（保持不变）----------
async function sendEmail(type, toEmail, subject, message, taskName = '') {
  console.log('环境变量检查:', {
    USER_ID: !!process.env.USER_ID,
    PRIVATE_KEY: !!process.env.PRIVATE_KEY,
    SERVICE_ID: !!process.env.SERVICE_ID,
    FROM_EMAIL: !!process.env.FROM_EMAIL
  });

  const templateId = type === 'warning' 
    ? process.env.WARNING_TEMPLATE_ID 
    : (type === 'final' ? process.env.FINAL_TEMPLATE_ID : process.env.WARNING_TEMPLATE_ID);

  const payload = {
    service_id: process.env.SERVICE_ID,
    template_id: templateId,
    user_id: process.env.USER_ID,
    template_params: {
      to_email: toEmail,
      from_email: process.env.FROM_EMAIL,
      task_name: taskName,
      message: message,
      subject: subject
    },
    accessToken: process.env.PRIVATE_KEY
  };

  try {
    const response = await axios.post('https://api.emailjs.com/api/v1.0/email/send', payload, {
      headers: { 'Content-Type': 'application/json' }
    });
    console.log(`邮件发送成功: ${toEmail}`);
    return true;
  } catch (error) {
    console.error('邮件发送失败详细错误:', {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status
    });
    return false;
  }
}

// ---------- 生成随机验证码 ----------
function generateVerificationCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ---------- 发送登录验证码 ----------
app.post('/api/send-login-code', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: '邮箱不能为空' });

  const code = generateVerificationCode();
  const expires = Date.now() + 5 * 60 * 1000;
  verificationCodes.set(email, { code, expires });

  const success = await sendEmail(
    'login',
    email,
    '【心灵保险】登录验证码',
    `您的登录验证码是：${code}，有效期5分钟。`
  );

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

// ---------- 核心函数：检查单个任务状态并处理邮件 ----------
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
      const success = await sendEmail(
        'warning',
        task.warningEmail,
        '【心灵保险】打卡警告',
        task.warningMessage,
        task.name
      );
      if (success) {
        await pool.query(
          'UPDATE tasks SET "warningSent" = 1, "warningTriggeredAt" = $1 WHERE id = $2',
          [now, task.id]
        );
      }
    }
  } else if (overdueDays >= warningDays + finalDays) {
    if (task.warningTriggeredAt) {
      const finalDiffMs = now - task.warningTriggeredAt;
      const finalDaysSince = Math.floor(finalDiffMs / (24 * 60 * 60 * 1000));
      if (finalDaysSince >= finalDays && !task.finalSent) {
        const success = await sendEmail(
          'final',
          task.finalEmail,
          '【心灵保险】任务终止通知',
          task.finalMessage,
          task.name
        );
        if (success) {
          await pool.query(
            'UPDATE tasks SET "finalSent" = 1 WHERE id = $1',
            [task.id]
          );
        }
      }
    } else {
      if (!task.finalSent) {
        const success = await sendEmail(
          'final',
          task.finalEmail,
          '【心灵保险】任务终止通知',
          task.finalMessage,
          task.name
        );
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
// ---8日加上日志---
console.log('尝试注册定时任务...');
cron.schedule('0 1 * * *', async () => {
  console.log('运行定时任务检查任务状态...');
  // ...
});

// ---------- 定时任务：每天下午13点运行一次 ----------
cron.schedule('0 1 * * *', async () => {  // UTC时间
  console.log('运行定时任务检查任务状态...');
  try {
    const { rows: tasks } = await pool.query('SELECT * FROM tasks');
    for (const task of tasks) {
      await checkTask(task);
    }
  } catch (err) {
    console.error('定时任务执行失败', err);
  }
});

// ---------- API 路由（所有操作都需要邮箱参数）----------

// 获取当前用户的所有任务
app.get('/api/tasks', async (req, res) => {
  const email = req.query.email;
  if (!email) {
    return res.status(400).json({ error: '缺少 email 参数' });
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
  if (!task.user_email) {
    return res.status(400).json({ error: '缺少 user_email' });
  }
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
    warningTriggeredAt: null
  };
  try {
    await pool.query(
      `INSERT INTO tasks (
        id, user_email, name, "cycleDays", "warningDays", "finalDays", 
        "warningEmail", "finalEmail", "warningMessage", "finalMessage", 
        "lastCheckin", created, "warningSent", "finalSent", "warningTriggeredAt"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
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
  if (!email) {
    return res.status(400).json({ error: '缺少 email 参数' });
  }
  const updates = req.body;
  delete updates.user_email;
  delete updates.warningEmail;

  // 动态构建 SET 子句
  const setClause = Object.keys(updates).map((key, index) => `"${key}" = $${index + 1}`).join(', ');
  const values = Object.values(updates);
  values.push(id, email);

  try {
    const result = await pool.query(
      `UPDATE tasks SET ${setClause} WHERE id = $${values.length - 1} AND user_email = $${values.length}`,
      values
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: '任务不存在或无权操作' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 删除任务
app.delete('/api/tasks/:id', async (req, res) => {
  const { id } = req.params;
  const email = req.query.email;
  if (!email) {
    return res.status(400).json({ error: '缺少 email 参数' });
  }
  try {
    const result = await pool.query('DELETE FROM tasks WHERE id = $1 AND user_email = $2', [id, email]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: '任务不存在或无权操作' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 手动打卡
app.post('/api/tasks/:id/checkin', async (req, res) => {
  const { id } = req.params;
  const email = req.query.email;
  if (!email) {
    return res.status(400).json({ error: '缺少 email 参数' });
  }
  const now = Date.now();
  try {
    const result = await pool.query(
      `UPDATE tasks SET "lastCheckin" = $1, "warningSent" = 0, "finalSent" = 0, "warningTriggeredAt" = NULL 
       WHERE id = $2 AND user_email = $3`,
      [now, id, email]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: '任务不存在或无权操作' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 测试接口（不需要邮箱）
app.get('/api/test-email', async (req, res) => {
  console.log('📧 收到测试邮件请求');
  const testTask = {
    name: '测试任务',
    warningEmail: 'your-email@example.com',
    finalEmail: 'your-email@example.com',
    warningMessage: '这是一封测试警告邮件',
    finalMessage: '这是一封测试最终通知邮件'
  };
  try {
    const warningSuccess = await sendEmail('warning', testTask.warningEmail, '测试警告', testTask.warningMessage, testTask.name);
    const finalSuccess = await sendEmail('final', testTask.finalEmail, '测试最终', testTask.finalMessage, testTask.name);
    res.json({ 
      success: warningSuccess && finalSuccess,
      warning: warningSuccess ? '✅ 警告邮件发送成功' : '❌ 警告邮件发送失败',
      final: finalSuccess ? '✅ 最终邮件发送成功' : '❌ 最终邮件发送失败'
    });
  } catch (error) {
    console.error('测试邮件接口出错:', error);
    res.status(500).json({ error: error.message });
  }
});

// 手动触发任务检查（用于调试）
app.get('/api/trigger-check', async (req, res) => {
  console.log('🔧 手动触发任务检查开始');
  try {
    const { rows: tasks } = await pool.query('SELECT * FROM tasks');
    console.log(`找到 ${tasks.length} 个任务`);
    
    for (const task of tasks) {
      // 复用你现有的 checkTask 函数
      await checkTask(task);
    }
    
    console.log('🔧 手动触发任务检查完成');
    res.json({ 
      success: true, 
      message: `检查完成，处理了 ${tasks.length} 个任务` 
    });
  } catch (error) {
    console.error('手动触发失败:', error);
    res.status(500).json({ error: error.message });
  }
});

// 健康检查接口
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// 启动服务器
app.listen(port, '0.0.0.0', () => {
  console.log(`后端服务运行在端口 ${port}`);
});