require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const cron = require('node-cron');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ---------- 内存存储验证码（邮箱 -> { code, expires }）----------
const verificationCodes = new Map();

// ---------- 初始化 SQLite 数据库 ----------
let db;
(async () => {
  db = await open({
    filename: './database.sqlite',
    driver: sqlite3.Database
  });

  // 创建 tasks 表（增加 user_email 字段用于数据隔离）
  await db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      user_email TEXT NOT NULL,      -- 新增：任务所属邮箱
      name TEXT NOT NULL,
      cycleDays INTEGER NOT NULL,
      warningDays INTEGER NOT NULL,
      finalDays INTEGER NOT NULL,
      warningEmail TEXT NOT NULL,
      finalEmail TEXT NOT NULL,
      warningMessage TEXT,
      finalMessage TEXT,
      lastCheckin INTEGER NOT NULL,
      created INTEGER NOT NULL,
      warningSent INTEGER DEFAULT 0,
      finalSent INTEGER DEFAULT 0,
      warningTriggeredAt INTEGER,
      verification_code TEXT,
      code_expires INTEGER
    )
  `);
  console.log('数据库初始化完成');
})();

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
  const expires = Date.now() + 5 * 60 * 1000; // 5分钟有效
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

// ---------- 核心函数：检查单个任务状态并处理邮件（不变）----------
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
      const success = await sendEmail(
        'warning',
        task.warningEmail,
        '【心灵保险】打卡警告',
        task.warningMessage,
        task.name
      );
      if (success) {
        await db.run(
          'UPDATE tasks SET warningSent = 1, warningTriggeredAt = ? WHERE id = ?',
          [now, task.id]
        );
      }
    }
  }
  // 最终状态
  else if (overdueDays >= warningDays + finalDays) {
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
          await db.run('UPDATE tasks SET finalSent = 1 WHERE id = ?', [task.id]);
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
          await db.run('UPDATE tasks SET finalSent = 1 WHERE id = ?', [task.id]);
        }
      }
    }
  }
}

// ---------- 定时任务：每天下午13点运行一次 ----------
cron.schedule('0 13 * * *', async () => {
  console.log('运行定时任务检查任务状态...');
  const tasks = await db.all('SELECT * FROM tasks');
  for (const task of tasks) {
    await checkTask(task);
  }
});

// ---------- API 路由（所有操作都需要邮箱参数）----------

// 获取当前用户的所有任务（需要邮箱）
app.get('/api/tasks', async (req, res) => {
  const email = req.query.email;
  if (!email) {
    return res.status(400).json({ error: '缺少 email 参数' });
  }
  try {
    const tasks = await db.all('SELECT * FROM tasks WHERE user_email = ?', email);
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 创建新任务（需要邮箱）
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
    await db.run(
      `INSERT INTO tasks (id, user_email, name, cycleDays, warningDays, finalDays, 
        warningEmail, finalEmail, warningMessage, finalMessage, lastCheckin, created,
        warningSent, finalSent, warningTriggeredAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      Object.values(newTask)
    );
    res.json(newTask);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 更新任务（需要邮箱，且只能更新自己的任务）
app.put('/api/tasks/:id', async (req, res) => {
  const { id } = req.params;
  const email = req.query.email;
  if (!email) {
    return res.status(400).json({ error: '缺少 email 参数' });
  }
  const updates = req.body;
  // 不允许修改 user_email 和 warningEmail（由前端保证不传）
  delete updates.user_email;
  delete updates.warningEmail;
  const setClause = Object.keys(updates).map(key => `${key} = ?`).join(', ');
  const values = [...Object.values(updates), id, email];
  try {
    const result = await db.run(
      `UPDATE tasks SET ${setClause} WHERE id = ? AND user_email = ?`,
      values
    );
    if (result.changes === 0) {
      return res.status(404).json({ error: '任务不存在或无权操作' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 删除任务（需要邮箱）
app.delete('/api/tasks/:id', async (req, res) => {
  const { id } = req.params;
  const email = req.query.email;
  if (!email) {
    return res.status(400).json({ error: '缺少 email 参数' });
  }
  try {
    const result = await db.run('DELETE FROM tasks WHERE id = ? AND user_email = ?', id, email);
    if (result.changes === 0) {
      return res.status(404).json({ error: '任务不存在或无权操作' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 手动打卡（需要邮箱）
app.post('/api/tasks/:id/checkin', async (req, res) => {
  const { id } = req.params;
  const email = req.query.email;
  if (!email) {
    return res.status(400).json({ error: '缺少 email 参数' });
  }
  const now = Date.now();
  try {
    const result = await db.run(
      'UPDATE tasks SET lastCheckin = ?, warningSent = 0, finalSent = 0, warningTriggeredAt = NULL WHERE id = ? AND user_email = ?',
      [now, id, email]
    );
    if (result.changes === 0) {
      return res.status(404).json({ error: '任务不存在或无权操作' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 测试接口（不需要邮箱，仅用于调试）
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

// 健康检查接口（用于唤醒）
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// 启动服务器
app.listen(port, '0.0.0.0', () => {
  console.log(`后端服务运行在端口 ${port}`);
});