const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { PDFDocument } = require('pdf-lib');
const archiver = require('archiver');
const app = express();
const port = 3000;

// 设置视图引擎
app.set('view engine', 'ejs');
app.use(express.static('public'));

// 确保上传和下载目录存在
const uploadDir = path.join(__dirname, 'upload');
const downloadDir = path.join(__dirname, 'download');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

if (!fs.existsSync(downloadDir)) {
  fs.mkdirSync(downloadDir);
}

// 配置文件上传
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    // 保存原始文件名
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: function (req, file, cb) {
    if (path.extname(file.originalname).toLowerCase() !== '.pdf') {
      return cb(new Error('只允许上传PDF文件'));
    }
    cb(null, true);
  }
});

// 修改安全文件名函数，保留英文文件名
function getSafeFilename(filename) {
  // 检查文件名是否只包含英文字母、数字和安全字符
  if (/^[a-zA-Z0-9_\-\.]+$/.test(filename)) {
    // 如果是纯英文文件名，直接返回
    return filename;
  }
  // 否则移除非字母数字字符，保留字母、数字和一些安全字符
  return filename.replace(/[^\w\d-_.]/g, '') || 'file';
}

// 首页 - 文件上传页面
app.get('/', (req, res) => {
  res.render('index');
});

// 处理文件上传
app.post('/upload', upload.single('pdfFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send('没有上传文件');
    }

    const uploadedFilePath = req.file.path;
    const originalFilename = path.parse(req.file.originalname).name;
    const safeFilename = getSafeFilename(originalFilename);
    const timestamp = Date.now();
    const folderName = `${safeFilename}_${timestamp}`;
    const outputDir = path.join(downloadDir, folderName);
    
    // 创建输出目录
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir);
    }
    
    // 读取PDF文件
    const pdfBytes = fs.readFileSync(uploadedFilePath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pageCount = pdfDoc.getPageCount();
    
    // 创建进度跟踪对象
    const processId = timestamp.toString();
    const progressData = {
      total: pageCount,
      current: 0,
      status: 'processing',
      files: [],
      folderName: folderName,
      originalFilename: originalFilename
    };
    
    // 存储进度数据
    app.locals[processId] = progressData;
    
    // 先返回处理页面，然后在后台继续处理
    res.render('processing', { 
      processId: processId,
      originalFilename: originalFilename,
      pageCount: pageCount 
    });
    
    // 设置超时处理 - 每页PDF处理的估计时间（毫秒）
    const estimatedTimePerPage = 500; // 可以根据实际情况调整
    const totalEstimatedTime = pageCount * estimatedTimePerPage;
    
    // 在后台处理PDF分割
    setTimeout(async () => {
      try {
        // 分割PDF
        for (let i = 0; i < pageCount; i++) {
          const newPdf = await PDFDocument.create();
          const [copiedPage] = await newPdf.copyPages(pdfDoc, [i]);
          newPdf.addPage(copiedPage);
          
          const fileName = `${originalFilename}_第${i+1}页.pdf`;
          const filePath = path.join(outputDir, fileName);
          
          const pdfBytes = await newPdf.save();
          fs.writeFileSync(filePath, pdfBytes);
          
          // 更新进度
          progressData.files.push({
            name: fileName,
            path: `/download/${folderName}/${fileName}`,
            pageNumber: i + 1
          });
          progressData.current = i + 1;
          
          // 每处理5页或处理到最后一页时，暂停一下，避免CPU过载
          if (i % 5 === 4 || i === pageCount - 1) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
        
        // 处理完成
        progressData.status = 'completed';
      } catch (error) {
        console.error('处理PDF时出错:', error);
        progressData.status = 'error';
        progressData.error = error.message;
      }
    }, 100);
    
  } catch (error) {
    console.error('处理PDF时出错:', error);
    res.status(500).send('处理PDF时出错: ' + error.message);
  }
});

// 获取处理进度的API
app.get('/progress/:processId', (req, res) => {
  const processId = req.params.processId;
  const progressData = app.locals[processId];
  
  if (!progressData) {
    return res.status(404).json({ error: '找不到处理任务' });
  }
  
  res.json(progressData);
});

// 结果页面
app.get('/result/:processId', (req, res) => {
  const processId = req.params.processId;
  const progressData = app.locals[processId];
  
  if (!progressData || progressData.status !== 'completed') {
    return res.redirect('/');
  }
  
  res.render('result', { 
    files: progressData.files, 
    originalFilename: progressData.originalFilename,
    pageCount: progressData.total,
    folderName: progressData.folderName
  });
  
  // 处理完成后，可以清理进度数据
  setTimeout(() => {
    delete app.locals[processId];
  }, 3600000); // 1小时后清理
});

// 修改下载文件的路由
app.get('/download/:folderName/:filename', (req, res) => {
  const folderName = req.params.folderName;
  const filename = req.params.filename;
  const filePath = path.join(downloadDir, folderName, filename);
  
  if (fs.existsSync(filePath)) {
    res.download(filePath);
  } else {
    res.status(404).send('文件不存在');
  }
});

// 添加批量下载功能
app.get('/download-all/:folderName', (req, res) => {
  const folderName = req.params.folderName;
  const folderPath = path.join(downloadDir, folderName);
  
  if (!fs.existsSync(folderPath)) {
    return res.status(404).send('文件夹不存在');
  }
  
  const zipFileName = `${folderName}.zip`;
  const zipFilePath = path.join(downloadDir, zipFileName);
  
  // 创建一个文件输出流
  const output = fs.createWriteStream(zipFilePath);
  const archive = archiver('zip', {
    zlib: { level: 9 } // 设置压缩级别
  });
  
  // 监听所有存档数据都已被写入底层流时触发
  output.on('close', function() {
    console.log(`${archive.pointer()} 字节总共写入`);
    res.download(zipFilePath, `${folderName}.zip`, (err) => {
      if (err) {
        console.error('下载ZIP文件时出错:', err);
      }
      
      // 下载完成后删除临时ZIP文件
      fs.unlink(zipFilePath, (err) => {
        if (err) console.error('删除临时ZIP文件时出错:', err);
      });
    });
  });
  
  // 监听警告
  archive.on('warning', function(err) {
    if (err.code === 'ENOENT') {
      console.warn('警告:', err);
    } else {
      console.error('压缩文件时出错:', err);
      res.status(500).send('压缩文件时出错');
    }
  });
  
  // 监听错误
  archive.on('error', function(err) {
    console.error('压缩文件时出错:', err);
    res.status(500).send('压缩文件时出错');
  });
  
  // 将输出流与归档文件关联
  archive.pipe(output);
  
  // 将文件夹中的所有文件添加到归档
  fs.readdirSync(folderPath).forEach(file => {
    const filePath = path.join(folderPath, file);
    archive.file(filePath, { name: file });
  });
  
  // 完成归档
  archive.finalize();
});

app.listen(port, () => {
  console.log(`应用运行在 http://localhost:${port}`);
}); 