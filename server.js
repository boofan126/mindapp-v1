const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// 托管静态文件（让前端能访问图片、PDF 和 index.html 本身）
app.use(express.static(path.join(__dirname, './')));

// API 接口：返回页面内容（标题、介绍段落、PDF链接）
app.get('/api/content', (req, res) => {
  res.json({
    title: '冷调文档',                 // 页面标题
    description: [                    // 介绍文字（支持多段）
      '🌱 这里是简洁的介绍文字。你可以写一段很长的内容，比如产品说明、项目背景、故事叙述等。由于内容由后端提供，修改时无需重新部署前端。',
      '冷色调背景营造专业、冷静的氛围。你可以随意替换这段文字，甚至加入多个段落。每个段落都会自动撑开卡片，整个页面会随着内容变长而滚动。',
      '如果需要添加更多内容，比如列表、引用等，只需在后端 API 的 description 数组里增加字符串即可。'
    ],
    pdfUrl: '/files/document.pdf'      // PDF 链接（可使用相对路径或绝对URL）
    // 如果你希望链接到外部 PDF，也可以写成 "https://example.com/doc.pdf"
  });
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});