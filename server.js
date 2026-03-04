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

// ---------- 初始化 SQLite 数据库 ----------
let db;
(async () => {
  db = await open({
    filename: './database.sqlite',
    driver: sqlite3.Database
  });

  // 创建 tasks 表（字段名改为 device_id）
  await db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
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

// ---------- 辅助函数：发送邮件 ----------
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
    user_id: process.env.USER_ID,  // 这是 EmailJS 的 user_id，保持不变
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

// ---------- 验证码接口 ----------
app.post('/api/send-verification-code', async (req, res) => {
  const { taskId } = req.body;
  if (!taskId) return res.status(400).json({ error: '缺少 taskId' });

  try {
    const task = await db.get('SELECT * FROM tasks WHERE id = ?', taskId);
    if (!task) return res.status(404).json({ error: '任务不存在' });

    const code = generateVerificationCode();
    const expires = Date.now() + 5 * 60 * 1000;
    await db.run(
      'UPDATE tasks SET verification_code = ?, code_expires = ? WHERE id = ?',
      [code, expires, taskId]
    );

    const success = await sendEmail(
      'verification',
      task.warningEmail,
      '【心灵保险】编辑终止通知验证码',
      `您的验证码是：${code}，有效期5分钟。`,
      task.name
    );

    if (success) res.json({ success: true, message: '验证码已发送' });
    else res.status(500).json({ error: '验证码发送失败' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/verify-code', async (req, res) => {
  const { taskId, code } = req.body;
  if (!taskId || !code) return res.status(400).json({ error: '缺少参数' });

  try {
    const task = await db.get('SELECT * FROM tasks WHERE id = ?', taskId);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    if (!task.verification_code || !task.code_expires) {
      return res.status(400).json({ error: '未请求验证码或验证码已过期' });
    }
    if (Date.now() > task.code_expires) {
      return res.status(400).json({ error: '验证码已过期，请重新获取' });
    }
    if (task.verification_code !== code) {
      return res.status(400).json({ error: '验证码错误' });
    }
    await db.run('UPDATE tasks SET verification_code = NULL, code_expires = NULL WHERE id = ?', taskId);
    res.json({ success: true, message: '验证成功' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
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

// ---------- API 路由 ----------

// 获取指定设备的所有任务
app.get('/api/tasks', async (req, res) => {
  const deviceId = req.query.deviceId;
  if (!deviceId) {
    return res.status(400).json({ error: '缺少 deviceId 参数' });
  }
  try {
    const tasks = await db.all('SELECT * FROM tasks WHERE device_id = ?', deviceId);
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 创建新任务
app.post('/api/tasks', async (req, res) => {
  const task = req.body;
  if (!task.device_id) {
    return res.status(400).json({ error: '缺少 device_id' });
  }
  const now = Date.now();
  const newTask = {
    id: task.id || `task_${now}_${Math.random().toString(36).substr(2, 4)}`,
    device_id: task.device_id,
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
      `INSERT INTO tasks (id, device_id, name, cycleDays, warningDays, finalDays, 
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

// 更新任务（需验证 deviceId）
app.put('/api/tasks/:id', async (req, res) => {
  const { id } = req.params;
  const deviceId = req.query.deviceId;
  if (!deviceId) {
    return res.status(400).json({ error: '缺少 deviceId 参数' });
  }
  const updates = req.body;
  delete updates.device_id; // 不允许修改设备ID
  const setClause = Object.keys(updates).map(key => `${key} = ?`).join(', ');
  const values = [...Object.values(updates), id, deviceId];
  try {
    const result = await db.run(
      `UPDATE tasks SET ${setClause} WHERE id = ? AND device_id = ?`,
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

// 删除任务（需验证 deviceId）
app.delete('/api/tasks/:id', async (req, res) => {
  const { id } = req.params;
  const deviceId = req.query.deviceId;
  if (!deviceId) {
    return res.status(400).json({ error: '缺少 deviceId 参数' });
  }
  try {
    const result = await db.run('DELETE FROM tasks WHERE id = ? AND device_id = ?', id, deviceId);
    if (result.changes === 0) {
      return res.status(404).json({ error: '任务不存在或无权操作' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 手动打卡（需验证 deviceId）
app.post('/api/tasks/:id/checkin', async (req, res) => {
  const { id } = req.params;
  const deviceId = req.query.deviceId;
  if (!deviceId) {
    return res.status(400).json({ error: '缺少 deviceId 参数' });
  }
  const now = Date.now();
  try {
    const result = await db.run(
      'UPDATE tasks SET lastCheckin = ?, warningSent = 0, finalSent = 0, warningTriggeredAt = NULL WHERE id = ? AND device_id = ?',
      [now, id, deviceId]
    );
    if (result.changes === 0) {
      return res.status(404).json({ error: '任务不存在或无权操作' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 测试接口（不需要 deviceId）
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

// 启动服务器
app.listen(port, '0.0.0.0', () => {
  console.log(`后端服务运行在端口 ${port}`);
});