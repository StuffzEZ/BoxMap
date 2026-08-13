const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const Jimp = require('jimp');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// Simple logger with levels (default: debug)
const LOG_LEVEL = (process.env.LOG_LEVEL || 'debug').toLowerCase();
const levels = { error: 0, warn: 1, info: 2, debug: 3 };
function shouldLog(level) { return levels[level] <= (levels[LOG_LEVEL] ?? 3); }
const logger = {
  debug: (...args) => { if (shouldLog('debug')) console.log(new Date().toISOString(), '[DEBUG]', ...args); },
  info: (...args) => { if (shouldLog('info')) console.log(new Date().toISOString(), '[INFO]', ...args); },
  warn: (...args) => { if (shouldLog('warn')) console.warn(new Date().toISOString(), '[WARN]', ...args); },
  error: (...args) => { if (shouldLog('error')) console.error(new Date().toISOString(), '[ERROR]', ...args); }
};

// Helper to redact sensitive headers when logging
function redactHeaders(h) {
  const copy = Object.assign({}, h);
  if (copy['x-admin-password']) copy['x-admin-password'] = 'REDACTED';
  return copy;
}

const app = express();
const PORT = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const IMAGE_RECOGNITION_ENABLED = process.env.IMAGE_RECOGNITION_ENABLED === 'true';

// Ensure directories exist
const dataDir = path.join(__dirname, 'data');
const uploadsDir = path.join(__dirname, 'uploads', 'images');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Database setup
const db = new Database(path.join(dataDir, 'boxmap.db'));
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS boxes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    unit_id TEXT,
    image TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    box_id TEXT,
    image TEXT,
    -- location moved to boxes as unit/location reference
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (box_id) REFERENCES boxes(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS units (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Request logging middleware (redacts admin password)
app.use((req, res, next) => {
  try {
    const safeHeaders = redactHeaders(req.headers || {});
    logger.info(`${req.method} ${req.originalUrl}`);
    logger.debug('Headers:', safeHeaders);
    if (['POST','PUT','PATCH'].includes(req.method)) {
      // Avoid logging potentially large file buffers; log body keys only
      if (req.body && Object.keys(req.body).length) {
        const bodyCopy = { ...req.body };
        if (bodyCopy.password) bodyCopy.password = 'REDACTED';
        logger.debug('Body:', bodyCopy);
      }
    }
  } catch (e) {
    logger.warn('Failed to log request', e);
  }
  next();
});

// Multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// Auth middleware
const authenticate = (req, res, next) => {
  const password = req.headers['x-admin-password'] || req.query.password;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// ============ API ROUTES ============

// Scan QR code
app.post('/api/scan', (req, res) => {
  const { qr_code } = req.body;
  if (!qr_code) {
    return res.status(400).json({ error: 'QR code is required' });
  }

  const code = qr_code.trim().toUpperCase();

  if (code.startsWith('BOX')) {
    const box = db.prepare('SELECT * FROM boxes WHERE id = ?').get(code);
    if (!box) {
      return res.json({ type: 'box', found: false, id: code });
    }
    const items = db.prepare('SELECT * FROM items WHERE box_id = ?').all(code);
    let unit = null;
    if (box.unit_id) unit = db.prepare('SELECT * FROM units WHERE id = ?').get(box.unit_id);
    return res.json({ type: 'box', found: true, data: box, unit, items });
  }

  if (code.startsWith('ITM')) {
    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(code);
    if (!item) {
      return res.json({ type: 'item', found: false, id: code });
    }
    const box = item.box_id ? db.prepare('SELECT * FROM boxes WHERE id = ?').get(item.box_id) : null;
    let unit = null;
    if (box && box.unit_id) unit = db.prepare('SELECT * FROM units WHERE id = ?').get(box.unit_id);
    return res.json({ type: 'item', found: true, data: item, box, unit });
  }

  return res.status(400).json({ error: 'Invalid QR code format. Must start with BOX or ITM' });
});

// Image recognition endpoint
app.post('/api/recognize', upload.single('image'), async (req, res) => {
  if (!IMAGE_RECOGNITION_ENABLED) {
    return res.status(400).json({ error: 'Image recognition is disabled' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'Image is required' });
  }

  // Compute perceptual hash for uploaded image and compare to item images
  const uploadedPath = path.join(uploadsDir, req.file.filename);

  const itemsWithImages = db.prepare('SELECT id, name, image FROM items WHERE image IS NOT NULL').all();

  const results = [];

  try {
    const fileBuffer = fs.readFileSync(uploadedPath);
    const uploaded = await Jimp.read(fileBuffer);
    const uploadedHash = uploaded.hash();

    const hexToBin = (hex) => {
      return hex.split('').map(h => parseInt(h, 16).toString(2).padStart(4, '0')).join('');
    };

    const hamming = (h1, h2) => {
      const b1 = hexToBin(h1);
      const b2 = hexToBin(h2);
      let diff = 0;
      for (let i = 0; i < Math.min(b1.length, b2.length); i++) {
        if (b1[i] !== b2[i]) diff++;
      }
      return diff + Math.abs(b1.length - b2.length);
    };

    for (const it of itemsWithImages) {
      try {
        const imgPath = path.join(__dirname, it.image);
        if (!fs.existsSync(imgPath)) continue;
        const candidate = await Jimp.read(imgPath);
        const candidateHash = candidate.hash();
        const dist = hamming(uploadedHash, candidateHash);
        results.push({ id: it.id, name: it.name, image: it.image, distance: dist });
      } catch (e) {
        // skip broken images
      }
    }

    // Sort by smallest distance (best match first)
    results.sort((a, b) => a.distance - b.distance);

    // Determine matches with a reasonable threshold (lower is better). Threshold 12 is conservative.
    const matches = results.filter(r => r.distance <= 12).slice(0, 10);

    // Encode uploaded image as data URL so we can remove the temp file
    const dataUrl = `data:${req.file.mimetype};base64,${fileBuffer.toString('base64')}`;

    // Remove the temporary uploaded file immediately
    try { fs.unlinkSync(uploadedPath); } catch (e) { /* ignore */ }

    res.json({
      success: true,
      imageUrl: dataUrl,
      matches,
      allCandidates: results.slice(0, 20),
      message: matches.length ? 'Possible matches found' : 'No confident matches; showing candidates for manual selection'
    });
  } catch (err) {
    // Fallback to manual listing if hash fails
    try { fs.unlinkSync(uploadedPath); } catch (e) { /* ignore */ }
    return res.json({ 
      success: true,
      imageUrl: null,
      items: itemsWithImages,
      message: 'Could not perform automatic matching; select the item that matches this image'
    });
  }
});

// ============ BOXES CRUD ============

app.get('/api/boxes', (req, res) => {
  const boxes = db.prepare('SELECT * FROM boxes ORDER BY created_at DESC').all();
  // attach unit info
  for (const b of boxes) {
    if (b.unit_id) {
      b.unit = db.prepare('SELECT * FROM units WHERE id = ?').get(b.unit_id);
    } else {
      b.unit = null;
    }
  }
  res.json(boxes);
});

app.get('/api/boxes/:id', (req, res) => {
  const box = db.prepare('SELECT * FROM boxes WHERE id = ?').get(req.params.id);
  if (!box) return res.status(404).json({ error: 'Box not found' });
  const items = db.prepare('SELECT * FROM items WHERE box_id = ?').all(req.params.id);
  let unit = null;
  if (box.unit_id) unit = db.prepare('SELECT * FROM units WHERE id = ?').get(box.unit_id);
  res.json({ ...box, unit, items });
});

app.post('/api/boxes', authenticate, upload.single('image'), (req, res) => {
  const { id, name, description } = req.body;
  const unit_id = req.body.unit_id || null;
  if (!id || !name) {
    return res.status(400).json({ error: 'ID and name are required' });
  }

  const code = id.trim().toUpperCase();
  if (!code.startsWith('BOX')) {
    return res.status(400).json({ error: 'Box ID must start with BOX' });
  }

  const existing = db.prepare('SELECT id FROM boxes WHERE id = ?').get(code);
  if (existing) {
    return res.status(400).json({ error: 'Box ID already exists' });
  }

  const image = req.file ? `/uploads/images/${req.file.filename}` : null;

  if (unit_id) {
    const unit = db.prepare('SELECT id FROM units WHERE id = ?').get(unit_id);
    if (!unit) return res.status(400).json({ error: 'Unit not found' });
  }

  db.prepare('INSERT INTO boxes (id, name, description, unit_id, image) VALUES (?, ?, ?, ?, ?)')
    .run(code, name, description || '', unit_id, image);

  res.json({ success: true, id: code });
});

app.put('/api/boxes/:id', authenticate, upload.single('image'), (req, res) => {
  const { name, description } = req.body;
  const unit_id = req.body.unit_id || null;
  const box = db.prepare('SELECT * FROM boxes WHERE id = ?').get(req.params.id);
  if (!box) return res.status(404).json({ error: 'Box not found' });

  const image = req.file ? `/uploads/images/${req.file.filename}` : box.image;

  if (unit_id) {
    const unit = db.prepare('SELECT id FROM units WHERE id = ?').get(unit_id);
    if (!unit) return res.status(400).json({ error: 'Unit not found' });
  }

  db.prepare('UPDATE boxes SET name = ?, description = ?, unit_id = ?, image = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(name || box.name, description || box.description, unit_id, image, req.params.id);

  res.json({ success: true });
});

app.delete('/api/boxes/:id', authenticate, (req, res) => {
  const box = db.prepare('SELECT * FROM boxes WHERE id = ?').get(req.params.id);
  if (!box) return res.status(404).json({ error: 'Box not found' });

  db.prepare('UPDATE items SET box_id = NULL WHERE box_id = ?').run(req.params.id);
  db.prepare('DELETE FROM boxes WHERE id = ?').run(req.params.id);

  if (box.image) {
    const imgPath = path.join(__dirname, box.image);
    if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
  }

  res.json({ success: true });
});

// ============ ITEMS CRUD ============

app.get('/api/items', (req, res) => {
  const items = db.prepare('SELECT * FROM items ORDER BY created_at DESC').all();
  res.json(items);
});

app.get('/api/items/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const box = item.box_id ? db.prepare('SELECT * FROM boxes WHERE id = ?').get(item.box_id) : null;
  let unit = null;
  if (box && box.unit_id) unit = db.prepare('SELECT * FROM units WHERE id = ?').get(box.unit_id);
  res.json({ ...item, box, unit });
});

app.post('/api/items', authenticate, upload.single('image'), (req, res) => {
  const { id, name, description, box_id, location } = req.body;
  if (!id || !name) {
    return res.status(400).json({ error: 'ID and name are required' });
  }

  const code = id.trim().toUpperCase();
  if (!code.startsWith('ITM')) {
    return res.status(400).json({ error: 'Item ID must start with ITM' });
  }

  const existing = db.prepare('SELECT id FROM items WHERE id = ?').get(code);
  if (existing) {
    return res.status(400).json({ error: 'Item ID already exists' });
  }

  if (box_id) {
    const box = db.prepare('SELECT id FROM boxes WHERE id = ?').get(box_id);
    if (!box) return res.status(400).json({ error: 'Box not found' });
  }

  const image = req.file ? `/uploads/images/${req.file.filename}` : null;

  db.prepare('INSERT INTO items (id, name, description, box_id, image, location) VALUES (?, ?, ?, ?, ?, ?)')
    .run(code, name, description || '', box_id || null, image, location || '');

  res.json({ success: true, id: code });
});

app.put('/api/items/:id', authenticate, upload.single('image'), (req, res) => {
  const { name, description, box_id, location } = req.body;
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  if (box_id) {
    const box = db.prepare('SELECT id FROM boxes WHERE id = ?').get(box_id);
    if (!box) return res.status(400).json({ error: 'Box not found' });
  }

  const image = req.file ? `/uploads/images/${req.file.filename}` : item.image;

  db.prepare('UPDATE items SET name = ?, description = ?, box_id = ?, image = ?, location = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(name || item.name, description || item.description, box_id || item.box_id, image, location || item.location, req.params.id);

  res.json({ success: true });
});

app.delete('/api/items/:id', authenticate, (req, res) => {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id);

  if (item.image) {
    const imgPath = path.join(__dirname, item.image);
    if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
  }

  res.json({ success: true });
});

// ============ PDF LABEL GENERATION ============

app.get('/api/labels/pdf', authenticate, async (req, res) => {
  const { ids, template, start_index, fontName, fontSizeName, fontSizeId, showDescription, includeImage } = req.query;
  
  if (!ids) {
    return res.status(400).json({ error: 'IDs are required' });
  }

  const idList = ids.split(',').map(id => id.trim().toUpperCase());
  
  // Template configurations (sizes in PDF points for US Letter 612x792)
  const templates = {
    'avery-5160': { width: 612, height: 792, labelsPerSheet: 30, cols: 3, rows: 10, labelWidth: 180, labelHeight: 54, marginLeft: 18, marginTop: 36, colGap: 9, rowGap: 0, hasBorder: false, qrSize: 40 },
    'avery-5161': { width: 612, height: 792, labelsPerSheet: 40, cols: 4, rows: 10, labelWidth: 136, labelHeight: 54, marginLeft: 18, marginTop: 36, colGap: 9, rowGap: 0, hasBorder: false, qrSize: 36 },
    'avery-5162': { width: 612, height: 792, labelsPerSheet: 21, cols: 3, rows: 7, labelWidth: 180, labelHeight: 72, marginLeft: 18, marginTop: 54, colGap: 9, rowGap: 18, hasBorder: false, qrSize: 50 },
    'dymo-30252': { width: 612, height: 792, labelsPerSheet: 14, cols: 2, rows: 7, labelWidth: 252, labelHeight: 72, marginLeft: 72, marginTop: 36, colGap: 36, rowGap: 18, hasBorder: true, qrSize: 55 },
    'borderless-14': { width: 612, height: 792, labelsPerSheet: 14, cols: 2, rows: 7, labelWidth: 270, labelHeight: 72, marginLeft: 36, marginTop: 36, colGap: 18, rowGap: 18, hasBorder: false, qrSize: 55 },
    'address-2x8': { width: 612, height: 792, labelsPerSheet: 16, cols: 2, rows: 8, labelWidth: 270, labelHeight: 90, marginLeft: 36, marginTop: 30, colGap: 18, rowGap: 12, hasBorder: false, qrSize: 60 },
    'small-3x8': { width: 612, height: 792, labelsPerSheet: 24, cols: 3, rows: 8, labelWidth: 172, labelHeight: 90, marginLeft: 18, marginTop: 30, colGap: 6, rowGap: 12, hasBorder: false, qrSize: 48 }
  };

  const tmpl = templates[template] || templates['dymo-30252'];
  const startIndex = parseInt(start_index) || 0;

  // Formatting options
  function nineOrDefault(val, def) { return isNaN(val) ? def : val; }
  const nameFontSize = nineOrDefault(parseInt(fontSizeName), 9);
  const idFontSize = nineOrDefault(parseInt(fontSizeId), 7);
  const descFontSize = showDescription === 'false' ? 0 : (nineOrDefault(parseInt(req.query.fontSizeDesc), 6));
  const useImage = includeImage === 'true';

  const doc = new PDFDocument({ size: [tmpl.width, tmpl.height], margin: 0 });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename=labels.pdf');
  doc.pipe(res);

  let labelIndex = startIndex || 0;

  for (let i = 0; i < idList.length; i++) {
    const id = idList[i];

    // Handle pagination: add a new page for each sheet when needed
    const pageLabelIndex = labelIndex % tmpl.labelsPerSheet;
    if (labelIndex > 0 && pageLabelIndex === 0) {
      doc.addPage({ size: [tmpl.width, tmpl.height], margin: 0 });
    }

    const col = pageLabelIndex % tmpl.cols;
    const row = Math.floor(pageLabelIndex / tmpl.cols);
    const x = tmpl.marginLeft + col * (tmpl.labelWidth + tmpl.colGap);
    const y = tmpl.marginTop + row * (tmpl.labelHeight + tmpl.rowGap);

    if (tmpl.hasBorder) {
      doc.save();
      doc.lineWidth(0.8);
      doc.strokeColor('#000000');
      doc.rect(x, y, tmpl.labelWidth, tmpl.labelHeight).stroke();
      doc.restore();
    }

    // Get data
    let data = null;
    let type = '';
    if (id.startsWith('BOX')) {
      data = db.prepare('SELECT * FROM boxes WHERE id = ?').get(id);
      type = 'BOX';
    } else if (id.startsWith('ITM')) {
      data = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
      type = 'ITEM';
    }

    // Generate QR code (encode full app URL so external scanners open the app)
    try {
      const urlToEncode = `${APP_URL.replace(/\/$/, '')}?id=${encodeURIComponent(id)}`;
      const qrBuffer = await QRCode.toBuffer(urlToEncode, { width: tmpl.qrSize, margin: 1, color: { dark: '#000000', light: '#FFFFFF' } });
      // Draw QR code on left side with small inner padding
      const qrPadding = 6;
      const qrX = x + qrPadding;
      const qrY = y + (tmpl.labelHeight - tmpl.qrSize) / 2;
      doc.image(qrBuffer, qrX, qrY, { width: tmpl.qrSize, height: tmpl.qrSize });
    } catch (err) {
      doc.fontSize(6).font('Helvetica');
      doc.text('[QR]', x + 6, y + 6, { width: tmpl.qrSize });
    }

    // Info on right side (calculate consistent paddings)
    const innerPadding = 8;
    const textX = x + 6 + tmpl.qrSize + innerPadding; // qrPadding + qrSize + innerPadding
    const textWidth = tmpl.labelWidth - (tmpl.qrSize + innerPadding + 6 + 8); // right padding

    if (data) {
      doc.fontSize(nameFontSize).font('Helvetica-Bold');
      doc.text(data.name, textX, y + 5, { width: textWidth, continued: false });

      doc.fontSize(idFontSize).font('Helvetica');
      doc.text(id, textX, y + 5 + nameFontSize + 2, { width: textWidth });

      if (descFontSize > 0 && data.description) {
        doc.fontSize(descFontSize).font('Helvetica');
        doc.text(data.description || '', textX, y + 5 + nameFontSize + idFontSize + 6, { width: textWidth, height: tmpl.labelHeight - (nameFontSize + idFontSize + 12) });
      }

      // Small instruction encouraging scanning the QR
      try {
        doc.fontSize(6).font('Helvetica-Oblique');
        doc.text('Scan the QR code to see this on the website', textX, y + tmpl.labelHeight - 12, { width: textWidth });
      } catch (e) {}

      if (type === 'ITEM' && data.location) {
        doc.fontSize(Math.max(6, idFontSize - 1)).font('Helvetica-Oblique');
        doc.text(data.location, textX, y + tmpl.labelHeight - 14, { width: textWidth });
      }

      // Optionally include the item's photo (scaled) on the right if requested and available
      if (useImage && data.image) {
        try {
          const imgPath = path.join(__dirname, data.image);
          if (fs.existsSync(imgPath)) {
            const imgX = textX + textWidth - 40;
            const imgY = y + (tmpl.labelHeight - 40) / 2;
            doc.image(imgPath, imgX, imgY, { width: 36, height: 36 });
          }
        } catch (e) {
          // ignore image errors
        }
      }
    } else {
      doc.fontSize(7).font('Helvetica');
      doc.text(id, textX, y + 5, { width: textWidth });
    }

    labelIndex++;
  }

  doc.end();
});

// Also support POST for PDF generation so clients can send auth in headers and receive blob
app.post('/api/labels/pdf', authenticate, async (req, res) => {
  const { ids, template, start_index, fontName, fontSizeName, fontSizeId, showDescription, includeImage } = req.body || {};

  if (!ids) {
    return res.status(400).json({ error: 'IDs are required' });
  }

  const idList = ids.split(',').map(id => id.trim().toUpperCase());

  // Template configurations (sizes in PDF points for US Letter 612x792)
  const templates = {
    'avery-5160': { width: 612, height: 792, labelsPerSheet: 30, cols: 3, rows: 10, labelWidth: 180, labelHeight: 54, marginLeft: 18, marginTop: 36, colGap: 9, rowGap: 0, hasBorder: false, qrSize: 40 },
    'avery-5161': { width: 612, height: 792, labelsPerSheet: 40, cols: 4, rows: 10, labelWidth: 136, labelHeight: 54, marginLeft: 18, marginTop: 36, colGap: 9, rowGap: 0, hasBorder: false, qrSize: 36 },
    'avery-5162': { width: 612, height: 792, labelsPerSheet: 21, cols: 3, rows: 7, labelWidth: 180, labelHeight: 72, marginLeft: 18, marginTop: 54, colGap: 9, rowGap: 18, hasBorder: false, qrSize: 50 },
    'dymo-30252': { width: 612, height: 792, labelsPerSheet: 14, cols: 2, rows: 7, labelWidth: 252, labelHeight: 72, marginLeft: 72, marginTop: 36, colGap: 36, rowGap: 18, hasBorder: true, qrSize: 55 },
    'borderless-14': { width: 612, height: 792, labelsPerSheet: 14, cols: 2, rows: 7, labelWidth: 270, labelHeight: 72, marginLeft: 36, marginTop: 36, colGap: 18, rowGap: 18, hasBorder: false, qrSize: 55 },
    'address-2x8': { width: 612, height: 792, labelsPerSheet: 16, cols: 2, rows: 8, labelWidth: 270, labelHeight: 90, marginLeft: 36, marginTop: 30, colGap: 18, rowGap: 12, hasBorder: false, qrSize: 60 },
    'small-3x8': { width: 612, height: 792, labelsPerSheet: 24, cols: 3, rows: 8, labelWidth: 172, labelHeight: 90, marginLeft: 18, marginTop: 30, colGap: 6, rowGap: 12, hasBorder: false, qrSize: 48 }
  };

  const tmpl = templates[template] || templates['dymo-30252'];
  const startIndex = parseInt(start_index) || 0;

  // Formatting options
  function nineOrDefault(val, def) { return isNaN(val) ? def : val; }
  const nameFontSize = nineOrDefault(parseInt(fontSizeName), 9);
  const idFontSize = nineOrDefault(parseInt(fontSizeId), 7);
  const descFontSize = showDescription === 'false' ? 0 : (nineOrDefault(parseInt(req.body.fontSizeDesc), 6));
  const useImage = includeImage === 'true' || includeImage === true;

  const doc = new PDFDocument({ size: [tmpl.width, tmpl.height], margin: 0 });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename=labels.pdf');
  doc.pipe(res);

  let labelIndex = startIndex || 0;

  for (let i = 0; i < idList.length; i++) {
    const id = idList[i];

    // Handle pagination: add a new page for each sheet when needed
    const pageLabelIndex = labelIndex % tmpl.labelsPerSheet;
    if (labelIndex > 0 && pageLabelIndex === 0) {
      doc.addPage({ size: [tmpl.width, tmpl.height], margin: 0 });
    }

    const col = pageLabelIndex % tmpl.cols;
    const row = Math.floor(pageLabelIndex / tmpl.cols);
    const x = tmpl.marginLeft + col * (tmpl.labelWidth + tmpl.colGap);
    const y = tmpl.marginTop + row * (tmpl.labelHeight + tmpl.rowGap);

    if (tmpl.hasBorder) {
      doc.save();
      doc.lineWidth(0.8);
      doc.strokeColor('#000000');
      doc.rect(x, y, tmpl.labelWidth, tmpl.labelHeight).stroke();
      doc.restore();
    }

    // Get data
    let data = null;
    let type = '';
    if (id.startsWith('BOX')) {
      data = db.prepare('SELECT * FROM boxes WHERE id = ?').get(id);
      type = 'BOX';
    } else if (id.startsWith('ITM')) {
      data = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
      type = 'ITEM';
    }

    // Generate QR code (encode full app URL so external scanners open the app)
    try {
      const urlToEncode = `${APP_URL.replace(/\/$/, '')}?id=${encodeURIComponent(id)}`;
      const qrBuffer = await QRCode.toBuffer(urlToEncode, { width: tmpl.qrSize, margin: 1, color: { dark: '#000000', light: '#FFFFFF' } });
      const qrPadding = 6;
      const qrX = x + qrPadding;
      const qrY = y + (tmpl.labelHeight - tmpl.qrSize) / 2;
      doc.image(qrBuffer, qrX, qrY, { width: tmpl.qrSize, height: tmpl.qrSize });
    } catch (err) {
      doc.fontSize(6).font('Helvetica');
      doc.text('[QR]', x + 6, y + 6, { width: tmpl.qrSize });
    }

    // Info on right side (calculate consistent paddings)
    const innerPadding = 8;
    const textX = x + 6 + tmpl.qrSize + innerPadding; // qrPadding + qrSize + innerPadding
    const textWidth = tmpl.labelWidth - (tmpl.qrSize + innerPadding + 6 + 8); // right padding

    if (data) {
      doc.fontSize(nameFontSize).font('Helvetica-Bold');
      doc.text(data.name, textX, y + 5, { width: textWidth, continued: false });

      doc.fontSize(idFontSize).font('Helvetica');
      doc.text(id, textX, y + 5 + nameFontSize + 2, { width: textWidth });

      if (descFontSize > 0 && data.description) {
        doc.fontSize(descFontSize).font('Helvetica');
        doc.text(data.description || '', textX, y + 5 + nameFontSize + idFontSize + 6, { width: textWidth, height: tmpl.labelHeight - (nameFontSize + idFontSize + 12) });
      }

      if (type === 'ITEM' && data.location) {
        doc.fontSize(Math.max(6, idFontSize - 1)).font('Helvetica-Oblique');
        doc.text(data.location, textX, y + tmpl.labelHeight - 14, { width: textWidth });
      }

      // Optionally include the item's photo (scaled) on the right if requested and available
      if (useImage && data.image) {
        try {
          const imgPath = path.join(__dirname, data.image);
          if (fs.existsSync(imgPath)) {
            const imgX = textX + textWidth - 40;
            const imgY = y + (tmpl.labelHeight - 40) / 2;
            doc.image(imgPath, imgX, imgY, { width: 36, height: 36 });
          }
        } catch (e) {
          // ignore image errors
        }
      }
    } else {
      doc.fontSize(7).font('Helvetica');
      doc.text(id, textX, y + 5, { width: textWidth });
    }

    labelIndex++;
  }

  doc.end();
});

// Get label template options
app.get('/api/labels/templates', (req, res) => {
  res.json([
    { id: 'avery-5160', name: 'Avery 5160 (30 labels, no border)' },
    { id: 'avery-5161', name: 'Avery 5161 (40 labels, no border)' },
    { id: 'avery-5162', name: 'Avery 5162 (21 labels, no border)' },
    { id: 'dymo-30252', name: 'DYMO 30252 (14 labels, with border)' },
    { id: 'borderless-14', name: 'Borderless 14 labels' },
    { id: 'address-2x8', name: 'Address 2x8 (16 labels, larger)' },
    { id: 'small-3x8', name: 'Small 3x8 (24 labels, compact)' }
  ]);
});

// Units endpoints
app.get('/api/units', (req, res) => {
  const units = db.prepare('SELECT * FROM units ORDER BY name').all();
  res.json(units);
});

app.post('/api/units', authenticate, (req, res) => {
  try {
    const { id, name, description } = req.body;
    if (!id || !name) return res.status(400).json({ error: 'id and name required' });
    const code = id.trim().toUpperCase();
    const exists = db.prepare('SELECT id FROM units WHERE id = ?').get(code);
    if (exists) return res.status(400).json({ error: 'Unit id already exists' });
    db.prepare('INSERT INTO units (id, name, description) VALUES (?, ?, ?)').run(code, name, description || '');
    res.json({ success: true, id: code });
  } catch (err) {
    logger.error('Failed to create unit:', err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'Failed to create unit' });
  }
});

app.put('/api/units/:id', authenticate, (req, res) => {
  try {
    const id = req.params.id;
    const { name, description } = req.body;
    const unit = db.prepare('SELECT * FROM units WHERE id = ?').get(id);
    if (!unit) return res.status(404).json({ error: 'Unit not found' });
    db.prepare('UPDATE units SET name = ?, description = ? WHERE id = ?').run(name || unit.name, description || unit.description, id);
    res.json({ success: true });
  } catch (err) {
    logger.error('Failed to update unit:', err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'Failed to update unit' });
  }
});

app.delete('/api/units/:id', authenticate, (req, res) => {
  try {
    const id = req.params.id;
    const unit = db.prepare('SELECT * FROM units WHERE id = ?').get(id);
    if (!unit) return res.status(404).json({ error: 'Unit not found' });
    // clear unit references from boxes
    db.prepare('UPDATE boxes SET unit_id = NULL WHERE unit_id = ?').run(id);
    db.prepare('DELETE FROM units WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete unit:', err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'Failed to delete unit' });
  }
});

// Cleanup unreferenced uploaded images older than threshold (seconds)
function cleanupUploadsOlderThan(seconds = 3600) {
  try {
    const files = fs.readdirSync(uploadsDir);
    // Gather referenced basenames from DB
    const boxImages = db.prepare('SELECT image FROM boxes WHERE image IS NOT NULL').all().map(r => path.basename(r.image || ''));
    const itemImages = db.prepare('SELECT image FROM items WHERE image IS NOT NULL').all().map(r => path.basename(r.image || ''));
    const referenced = new Set([...boxImages, ...itemImages].filter(Boolean));

    for (const f of files) {
      const full = path.join(uploadsDir, f);
      try {
        const stat = fs.statSync(full);
        const age = (Date.now() - stat.mtimeMs) / 1000;
        if (!referenced.has(f) && age > seconds) {
          fs.unlinkSync(full);
          logger.info('Removed unreferenced upload:', f);
        }
      } catch (e) {
        // ignore
      }
    }
  } catch (e) {
    logger.warn('cleanupUploads failed', e);
  }
}

// Run a cleanup on startup and then periodically (every hour)
cleanupUploadsOlderThan(3600);
setInterval(() => cleanupUploadsOlderThan(3600), 1000 * 60 * 60);

// ============ SETTINGS ============

app.get('/api/settings', (req, res) => {
  res.json({
    imageRecognitionEnabled: IMAGE_RECOGNITION_ENABLED
  });
});

// ============ STATS ============

app.get('/api/stats', (req, res) => {
  const boxes = db.prepare('SELECT COUNT(*) as count FROM boxes').get();
  const items = db.prepare('SELECT COUNT(*) as count FROM items').get();
  const unassigned = db.prepare('SELECT COUNT(*) as count FROM items WHERE box_id IS NULL').get();
  
  res.json({
    totalBoxes: boxes.count,
    totalItems: items.count,
    unassignedItems: unassigned.count
  });
});

// Serve HTML pages
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  logger.info(`BoxMap running on http://localhost:${PORT}`);
  logger.info(`Admin panel: http://localhost:${PORT}/admin`);
  logger.info(`Image recognition: ${IMAGE_RECOGNITION_ENABLED ? 'ENABLED' : 'DISABLED'}`);
});

// Express error handler to log unexpected errors
app.use((err, req, res, next) => {
  logger.error('Unhandled error in request:', err && err.stack ? err.stack : err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Uncaught exceptions and rejections should be logged for debugging
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
});
