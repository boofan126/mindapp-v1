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

  // 创建 tasks 表
  await db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT DEFAULT 'default',
      name TEXT NOT NULL,
      cycleDays INTEGER NOT NULL,
      warningDays INTEGER NOT NULL,
      finalDays INTEGER NOT NULL,
      warningEmail TEXT NOT NULL,
      finalEmail TEXT NOT NULL,
      warningMessage TEXT,
      finalMessage TEXT,
      lastCheckin INTEGER NOT NULL,  -- 时间戳（毫秒）
      created INTEGER NOT NULL,
      warningSent INTEGER DEFAULT 0,
      finalSent INTEGER DEFAULT 0,
      warningTriggeredAt INTEGER       -- 记录警告触发的时间戳（毫秒）
    )
  `);
  console.log('数据库初始化完成');
})();

// ---------- 辅助函数：发送邮件 ----------
async function sendEmail(type, task) {
  console.log('环境变量检查:');
  console.log('- USER_ID 是否存在:', !!process.env.USER_ID);
  console.log('- PRIVATE_KEY 是否存在:', !!process.env.PRIVATE_KEY);
  console.log('- SERVICE_ID 是否存在:', !!process.env.SERVICE_ID);
  console.log('- WARNING_TEMPLATE_ID 是否存在:', !!process.env.WARNING_TEMPLATE_ID);
  console.log('- FINAL_TEMPLATE_ID 是否存在:', !!process.env.FINAL_TEMPLATE_ID);
  console.log('- FROM_EMAIL 是否存在:', !!process.env.FROM_EMAIL);

  const templateId = type === 'warning' 
    ? process.env.WARNING_TEMPLATE_ID 
    : process.env.FINAL_TEMPLATE_ID;
  const toEmail = type === 'warning' ? task.warningEmail : task.finalEmail;
  const message = type === 'warning' ? task.warningMessage : task.finalMessage;

  const payload = {
    service_id: process.env.SERVICE_ID,
    template_id: templateId,
    user_id: process.env.USER_ID,               // 对应 Render 的 USER_ID
    template_params: {
      to_email: toEmail,
      from_email: process.env.FROM_EMAIL,
      task_name: task.name,
      message: message
    },
    accessToken: process.env.PRIVATE_KEY         // 对应 Render 的 PRIVATE_KEY
  };

  try {
    const response = await axios.post('https://api.emailjs.com/api/v1.0/email/send', payload, {
      headers: { 'Content-Type': 'application/json' }
    });
    console.log(`邮件发送成功 (${type}): ${task.id}`);
    return true;
  } catch (error) {
    console.error('邮件发送失败详细错误:', {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status,
      headers: error.response?.headers
    });
    return false;
  }
}

// ---------- 核心函数：检查单个任务状态并处理邮件 ----------
async function checkTask(task) {
  const now = Date.now();
  const diffMs = now - task.lastCheckin;
  const virtualDays = Math.floor(diffMs / (60 * 1000)); // 1分钟 = 1天（测试用）

  const cycleDays = task.cycleDays;
  const warningDays = task.warningDays;
  const finalDays = task.finalDays;

  if (virtualDays <= cycleDays) {
    return; // 正常状态
  }

  const overdueDays = virtualDays - cycleDays;

  // 警告状态
  if (overdueDays >= warningDays && overdueDays < warningDays + finalDays) {
    if (!task.warningSent) {
      const success = await sendEmail('warning', task);
      if (success) {
        await db.run(
          'UPDATE tasks SET warningSent = 1, warningTriggeredAt = ? WHERE id = ?',
          [now, task.id]
        );
      }
    }
  }
  // 最终状态（从警告触发时刻开始计时）
  else if (overdueDays >= warningDays + finalDays) {
    if (task.warningTriggeredAt) {
      const finalDiffMs = now - task.warningTriggeredAt;
      const finalVirtualDays = Math.floor(finalDiffMs / (60 * 1000));
      if (finalVirtualDays >= finalDays && !task.finalSent) {
        const success = await sendEmail('final', task);
        if (success) {
          await db.run('UPDATE tasks SET finalSent = 1 WHERE id = ?', [task.id]);
        }
      }
    } else {
      // 没有 warningTriggeredAt（可能直接达到最终），按原逻辑处理
      if (!task.finalSent) {
        const success = await sendEmail('final', task);
        if (success) {
          await db.run('UPDATE tasks SET finalSent = 1 WHERE id = ?', [task.id]);
        }
      }
    }
  }
}

// ---------- 定时任务：每小时运行一次 ----------
cron.schedule('0 * * * *', async () => {
  console.log('运行定时任务检查任务状态...');
  const tasks = await db.all('SELECT * FROM tasks');
  for (const task of tasks) {
    await checkTask(task);
  }
});

// ---------- API 路由 ----------

// 获取所有任务
app.get('/api/tasks', async (req, res) => {
  try {
    const tasks = await db.all('SELECT * FROM tasks');
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 创建新任务
app.post('/api/tasks', async (req, res) => {
  const task = req.body;
  const now = Date.now();
  const newTask = {
    id: task.id || `task_${now}_${Math.random().toString(36).substr(2, 4)}`,
    user_id: task.user_id || 'default',
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
      `INSERT INTO tasks (id, user_id, name, cycleDays, warningDays, finalDays, 
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

// 更新任务
app.put('/api/tasks/:id', async (req, res) => {
  const { id } = req.params;
  const updates = req.body;
  const setClause = Object.keys(updates).map(key => `${key} = ?`).join(', ');
  const values = [...Object.values(updates), id];
  try {
    await db.run(`UPDATE tasks SET ${setClause} WHERE id = ?`, values);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 删除任务
app.delete('/api/tasks/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await db.run('DELETE FROM tasks WHERE id = ?', id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 手动打卡
app.post('/api/tasks/:id/checkin', async (req, res) => {
  const { id } = req.params;
  const now = Date.now();
  try {
    await db.run(
      'UPDATE tasks SET lastCheckin = ?, warningSent = 0, finalSent = 0, warningTriggeredAt = NULL WHERE id = ?',
      [now, id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 测试接口：手动触发发送测试邮件
app.get('/api/test-email', async (req, res) => {
  console.log('📧 收到测试邮件请求');
  const testTask = {
    name: '测试任务',
    warningEmail: '2924773@qq.com',   // 请替换为你自己的测试邮箱
    finalEmail: 'fanlitao@188.com',
    warningMessage: '这是一封测试警告邮件',
    finalMessage: '这是一封测试最终通知邮件'
  };
  try {
    console.log('尝试发送警告邮件...');
    const warningSuccess = await sendEmail('warning', testTask);
    console.log('尝试发送最终邮件...');
    const finalSuccess = await sendEmail('final', testTask);
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