import express from 'express';
import cors from 'cors';
import { initDB, getDB } from './db.js';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import os from 'os';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'qr-attendance-secret-2024';
const PORT = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());

console.log('🚀 Initializing QR Attendance System...');
await initDB();
console.log('✓ Database initialized');

const uploadsDir = process.env.RAILWAY_VOLUME_MOUNT_PATH 
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'staff')
  : path.join(__dirname, 'uploads', 'staff');
const baseUploadsDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? process.env.RAILWAY_VOLUME_MOUNT_PATH
  : path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log('✓ Created staff uploads directory:', uploadsDir);
}
if (!fs.existsSync(baseUploadsDir)) {
  fs.mkdirSync(baseUploadsDir, { recursive: true });
  console.log('✓ Created base uploads directory:', baseUploadsDir);
}

const copyLogoToVolume = () => {
  const repoLogoPath = path.join(__dirname, 'assets', 'logo.png');
  const volumeLogoPath = path.join(baseUploadsDir, 'logo.png');
  
  console.log('📋 Logo sync process started');
  console.log('   Source:', repoLogoPath);
  console.log('   Destination:', volumeLogoPath);
  
  if (!fs.existsSync(repoLogoPath)) {
    console.log('✗ Logo not found in repo assets folder');
    console.log('   Please ensure logo.png exists at:', repoLogoPath);
    return;
  }
  
  try {
    const sourceStats = fs.statSync(repoLogoPath);
    let shouldCopy = true;
    let reason = 'initial copy';
    
    if (fs.existsSync(volumeLogoPath)) {
      const destStats = fs.statSync(volumeLogoPath);
      if (sourceStats.size !== destStats.size || sourceStats.mtimeMs > destStats.mtimeMs) {
        reason = 'logo updated';
      } else {
        shouldCopy = false;
        console.log('✓ Logo already up-to-date in volume');
        return;
      }
    }
    
    if (shouldCopy) {
      fs.copyFileSync(repoLogoPath, volumeLogoPath);
      console.log(`✓ Logo copied to volume (${reason})`);
      console.log(`   Size: ${(sourceStats.size / 1024).toFixed(2)} KB`);
    }
  } catch (error) {
    console.error('✗ Failed to copy logo:', error.message);
  }
};

copyLogoToVolume();

app.use('/uploads', express.static(baseUploadsDir));
console.log('✓ Static files served from:', baseUploadsDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const staffId = req.body.staffId || 'temp';
    const ext = path.extname(file.originalname);
    cb(null, `${staffId}_${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error('Only JPG and PNG images allowed'));
  }
});

const logoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, baseUploadsDir);
  },
  filename: (req, file, cb) => {
    cb(null, 'logo.png');
  }
});

const logoUpload = multer({
  storage: logoStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error('Only JPG and PNG images allowed'));
  }
});

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.status(403).json({ error: 'Invalid token' });
  }
};

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const db = getDB();
    const [rows] = await db.execute('SELECT * FROM staff WHERE username = ?', [username]);
    if (rows.length === 0) {
      console.log('✗ Login failed: Username not found -', username);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      console.log('✗ Login failed: Invalid password -', username);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
    console.log(`✓ Login successful: ${username} [${user.role}] - ${user.name}`);
    res.json({ 
      token, 
      user: { 
        id: user.id, 
        name: user.name, 
        username: user.username, 
        role: user.role, 
        department: user.department, 
        position: user.position 
      } 
    });
  } catch (e) {
    console.error('✗ Login error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/staff', auth, async (req, res) => {
  try {
    const db = getDB();
    const [staff] = await db.execute(`
      SELECT id, name, username, department, position, email, phone, role, photo, created_at
      FROM staff 
      ORDER BY name
    `);
    const localIP = getLocalIP();
    const protocol = process.env.RAILWAY_STATIC_URL ? 'https' : 'http';
    const host = process.env.RAILWAY_STATIC_URL || `${localIP}:${PORT}`;
    const staffWithFullUrls = staff.map(member => {
      if (member.photo) {
        if (!member.photo.startsWith('http')) {
          member.photo_url = `${protocol}://${host}${member.photo}`;
        } else {
          member.photo_url = member.photo;
        }
      }
      return member;
    });
    console.log(`✓ Staff list retrieved: ${staff.length} members`);
    res.json(staffWithFullUrls);
  } catch (e) {
    console.error('✗ Error retrieving staff list:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/staff', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      console.log(`✗ Unauthorized staff creation attempt by user ID: ${req.user.id}`);
      return res.status(403).json({ error: 'Admin only' });
    }
    const { id, name, username, password, department, position, email, phone } = req.body;
    const hash = await bcrypt.hash(password, 10);
    const db = getDB();
    await db.execute(
      'INSERT INTO staff (id, name, username, password, department, position, email, phone) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, name, username, hash, department, position, email, phone]
    );
    console.log(`✓ Staff member created: ${name} [${id}] - ${department}`);
    res.json({ success: true, message: 'Staff added successfully', staffId: id });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      console.log(`✗ Duplicate entry: Username or ID already exists`);
      res.status(400).json({ error: 'Username or ID already exists' });
    } else {
      console.error('✗ Error creating staff member:', e.message);
      res.status(500).json({ error: e.message });
    }
  }
});

app.post('/api/staff/photo', auth, upload.single('photo'), async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      console.log(`✗ Unauthorized photo upload attempt by user ID: ${req.user.id}`);
      return res.status(403).json({ error: 'Admin only' });
    }
    const { staffId } = req.body;
    if (!staffId) {
      return res.status(400).json({ error: 'Staff ID required' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No photo uploaded' });
    }
    const photoUrl = `/uploads/staff/${req.file.filename}`;
    const protocol = process.env.RAILWAY_STATIC_URL ? 'https' : 'http';
    const localIP = getLocalIP();
    const host = process.env.RAILWAY_STATIC_URL || `${localIP}:${PORT}`;
    const fullPhotoUrl = `${protocol}://${host}${photoUrl}`;
    const db = getDB();
    try {
      const [oldRecord] = await db.execute('SELECT photo FROM staff WHERE id = ?', [staffId]);
      if (oldRecord.length > 0 && oldRecord[0].photo) {
        const oldFilename = path.basename(oldRecord[0].photo);
        const oldPath = path.join(uploadsDir, oldFilename);
        if (fs.existsSync(oldPath)) {
          fs.unlinkSync(oldPath);
          console.log(`✓ Old photo deleted: ${oldFilename}`);
        }
      }
    } catch (deleteErr) {
      console.error('✗ Error deleting old photo:', deleteErr.message);
    }
    const [updateResult] = await db.execute('UPDATE staff SET photo = ? WHERE id = ?', [photoUrl, staffId]);
    if (updateResult.affectedRows === 0) {
      return res.status(404).json({ error: 'Staff member not found' });
    }
    const [staff] = await db.execute('SELECT name FROM staff WHERE id = ?', [staffId]);
    const fileSize = (req.file.size / 1024).toFixed(2);
    console.log(`✓ Photo uploaded: ${staff[0]?.name || staffId} [${req.file.filename}] - ${fileSize} KB`);
    res.json({ 
      success: true, 
      photoUrl,
      photo_url: fullPhotoUrl,
      message: 'Photo uploaded successfully'
    });
  } catch (e) {
    if (req.file) {
      const uploadedPath = path.join(uploadsDir, req.file.filename);
      if (fs.existsSync(uploadedPath)) {
        fs.unlinkSync(uploadedPath);
      }
    }
    console.error('✗ Photo upload failed:', e.message);
    res.status(500).json({ 
      error: 'Photo upload failed',
      details: e.message 
    });
  }
});

app.delete('/api/staff/:staffId/photo', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      console.log(`✗ Unauthorized photo deletion attempt by user ID: ${req.user.id}`);
      return res.status(403).json({ error: 'Admin only' });
    }
    const { staffId } = req.params;
    if (!staffId) {
      return res.status(400).json({ error: 'Staff ID required' });
    }
    const db = getDB();
    const [staffRecord] = await db.execute('SELECT photo FROM staff WHERE id = ?', [staffId]);
    if (staffRecord.length === 0) {
      return res.status(404).json({ error: 'Staff member not found' });
    }
    if (staffRecord[0].photo) {
      const filename = path.basename(staffRecord[0].photo);
      const filePath = path.join(uploadsDir, filename);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
          console.log(`✓ Photo file deleted: ${filename}`);
        } catch (deleteErr) {
          console.error('✗ Error deleting photo file:', deleteErr.message);
        }
      }
    }
    const [updateResult] = await db.execute('UPDATE staff SET photo = NULL WHERE id = ?', [staffId]);
    if (updateResult.affectedRows === 0) {
      return res.status(404).json({ error: 'Failed to update staff record' });
    }
    const [staff] = await db.execute('SELECT name FROM staff WHERE id = ?', [staffId]);
    console.log(`✓ Photo removed from database: ${staff[0]?.name || staffId}`);
    res.json({ 
      success: true, 
      message: 'Photo removed successfully'
    });
  } catch (e) {
    console.error('✗ Photo removal failed:', e.message);
    res.status(500).json({ 
      error: 'Photo removal failed',
      details: e.message 
    });
  }
});

app.post('/api/logo/upload', auth, logoUpload.single('logo'), async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      console.log(`✗ Unauthorized logo upload attempt by user ID: ${req.user.id}`);
      return res.status(403).json({ error: 'Admin only' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No logo uploaded' });
    }
    const fileSize = (req.file.size / 1024).toFixed(2);
    const protocol = process.env.RAILWAY_STATIC_URL ? 'https' : 'http';
    const localIP = getLocalIP();
    const host = process.env.RAILWAY_STATIC_URL || `${localIP}:${PORT}`;
    const logoUrl = `/uploads/logo.png`;
    const fullLogoUrl = `${protocol}://${host}${logoUrl}`;
    console.log(`✓ Logo updated: ${req.file.filename} - ${fileSize} KB`);
    console.log(`   Accessible at: ${fullLogoUrl}`);
    res.json({ 
      success: true, 
      logoUrl,
      logo_url: fullLogoUrl,
      message: 'Logo updated successfully',
      size_kb: fileSize
    });
  } catch (e) {
    console.error('✗ Logo upload failed:', e.message);
    res.status(500).json({ 
      error: 'Logo upload failed',
      details: e.message 
    });
  }
});

app.post('/api/checkin', auth, async (req, res) => {
  try {
    const { staffId } = req.body;
    const today = new Date().toISOString().split('T')[0];
    const db = getDB();
    const [existing] = await db.execute(
      'SELECT * FROM attendance WHERE staff_id = ? AND date = ?',
      [staffId, today]
    );
    if (existing.length > 0) {
      console.log(`✗ Duplicate check-in attempt: ${staffId} - Already checked in today`);
      return res.status(400).json({ error: 'Already checked in today' });
    }
    const [maxIdResult] = await db.execute('SELECT COALESCE(MAX(id), 0) + 1 as next_id FROM attendance');
    const nextId = maxIdResult[0].next_id;
    await db.execute(
      'INSERT INTO attendance (id, staff_id, date, check_in) VALUES (?, ?, ?, NOW())',
      [nextId, staffId, today]
    );
    const [staff] = await db.execute('SELECT name FROM staff WHERE id = ?', [staffId]);
    const now = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`✓ Check-in: ${staff[0]?.name || staffId} at ${now} [ID: ${nextId}]`);
    res.json({ success: true, message: 'Check-in successful' });
  } catch (e) {
    console.error('✗ Check-in error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/checkout', auth, async (req, res) => {
  try {
    const { staffId } = req.body;
    if (!staffId) {
      return res.status(400).json({ success: false, error: 'Staff ID is required' });
    }
    const db = getDB();
    const [records] = await db.execute(
      'SELECT * FROM attendance WHERE staff_id = ? AND check_out IS NULL ORDER BY check_in DESC LIMIT 1',
      [staffId]
    );
    if (records.length === 0) {
      console.log(`✗ Check-out failed: ${staffId} - No active check-in found`);
      return res.status(400).json({ success: false, error: 'No active check-in found' });
    }
    const record = records[0];
    let breaks = [];
    let breaksAutoEnded = false;
    if (record.breaks) {
      try {
        breaks = typeof record.breaks === 'string' ? JSON.parse(record.breaks) : record.breaks;
        if (!Array.isArray(breaks)) breaks = [];
      } catch (e) {
        breaks = [];
      }
    }
    breaks = breaks.map(brk => {
      if (brk.start && !brk.end) {
        breaksAutoEnded = true;
        return { start: brk.start, end: new Date().toISOString(), auto_ended: true };
      }
      return brk;
    });
    await db.execute(
      'UPDATE attendance SET check_out = NOW(), breaks = ? WHERE id = ?',
      [JSON.stringify(breaks), record.id]
    );
    const [staff] = await db.execute('SELECT name FROM staff WHERE id = ?', [staffId]);
    const staffName = staff[0]?.name || staffId;
    const now = new Date().toLocaleTimeString('en-US', { hour12: false });
    if (breaksAutoEnded) {
      console.log(`✓ Check-out: ${staffName} at ${now} (active break auto-ended)`);
    } else {
      console.log(`✓ Check-out: ${staffName} at ${now}`);
    }
    res.json({ 
      success: true, 
      message: breaksAutoEnded ? `${staffName} checked out (active break was auto-ended)` : `${staffName} checked out successfully`,
      breaks_auto_ended: breaksAutoEnded
    });
  } catch (e) {
    console.error('✗ Check-out error:', e.message);
    res.status(500).json({ success: false, error: 'Server error during checkout', details: e.message });
  }
});

app.post('/api/attendance/break/start', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      console.log(`✗ Unauthorized break start attempt by user ID: ${req.user.id}`);
      return res.status(403).json({ success: false, error: 'Admin only' });
    }
    const { staffId } = req.body;
    if (!staffId) {
      return res.status(400).json({ success: false, error: 'Staff ID is required' });
    }
    const db = getDB();
    const [records] = await db.execute(
      'SELECT * FROM attendance WHERE staff_id = ? AND check_out IS NULL ORDER BY check_in DESC LIMIT 1',
      [staffId]
    );
    if (records.length === 0) {
      console.log(`✗ Break start failed: ${staffId} - No active shift found`);
      return res.status(400).json({ success: false, error: 'No active shift found. Please check in first.' });
    }
    const record = records[0];
    let breaks = [];
    if (record.breaks) {
      try {
        breaks = typeof record.breaks === 'string' ? JSON.parse(record.breaks) : record.breaks;
        if (!Array.isArray(breaks)) breaks = [];
      } catch (e) {
        breaks = [];
      }
    }
    const hasActiveBreak = breaks.some(b => b.start && !b.end);
    if (hasActiveBreak) {
      console.log(`✗ Break start failed: ${staffId} - Already on break`);
      return res.status(400).json({ success: false, error: 'Already on break' });
    }
    const now = new Date().toISOString();
    breaks.push({ start: now });
    await db.execute('UPDATE attendance SET breaks = ? WHERE id = ?', [JSON.stringify(breaks), record.id]);
    const [staff] = await db.execute('SELECT name FROM staff WHERE id = ?', [staffId]);
    const time = new Date(now).toLocaleTimeString('en-US', { hour12: false });
    console.log(`✓ Break started: ${staff[0]?.name || staffId} at ${time}`);
    res.json({ success: true, message: `${staff[0]?.name || 'Staff'} started break`, break_start: now });
  } catch (e) {
    console.error('✗ Break start error:', e.message);
    res.status(500).json({ success: false, error: 'Server error while starting break', details: e.message });
  }
});

app.post('/api/attendance/break/end', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      console.log(`✗ Unauthorized break end attempt by user ID: ${req.user.id}`);
      return res.status(403).json({ success: false, error: 'Admin only' });
    }
    const { staffId } = req.body;
    if (!staffId) {
      return res.status(400).json({ success: false, error: 'Staff ID is required' });
    }
    const db = getDB();
    const [records] = await db.execute(
      'SELECT * FROM attendance WHERE staff_id = ? AND check_out IS NULL ORDER BY check_in DESC LIMIT 1',
      [staffId]
    );
    if (records.length === 0) {
      console.log(`✗ Break end failed: ${staffId} - No active shift found`);
      return res.status(400).json({ success: false, error: 'No active shift found' });
    }
    const record = records[0];
    let breaks = [];
    if (record.breaks) {
      try {
        breaks = typeof record.breaks === 'string' ? JSON.parse(record.breaks) : record.breaks;
        if (!Array.isArray(breaks)) breaks = [];
      } catch (e) {
        breaks = [];
      }
    }
    const activeBreakIndex = breaks.findIndex(b => b.start && !b.end);
    if (activeBreakIndex === -1) {
      console.log(`✗ Break end failed: ${staffId} - No active break found`);
      return res.status(400).json({ success: false, error: 'No active break found' });
    }
    const now = new Date().toISOString();
    breaks[activeBreakIndex].end = now;
    await db.execute('UPDATE attendance SET breaks = ? WHERE id = ?', [JSON.stringify(breaks), record.id]);
    const [staff] = await db.execute('SELECT name FROM staff WHERE id = ?', [staffId]);
    const breakStart = new Date(breaks[activeBreakIndex].start);
    const breakEnd = new Date(now);
    const breakMinutes = Math.floor((breakEnd - breakStart) / (1000 * 60));
    const time = new Date(now).toLocaleTimeString('en-US', { hour12: false });
    console.log(`✓ Break ended: ${staff[0]?.name || staffId} at ${time} (duration: ${breakMinutes} min)`);
    res.json({ 
      success: true, 
      message: `${staff[0]?.name || 'Staff'} ended break (${breakMinutes} minutes)`,
      break_end: now,
      break_duration_minutes: breakMinutes
    });
  } catch (e) {
    console.error('✗ Break end error:', e.message);
    res.status(500).json({ success: false, error: 'Server error while ending break', details: e.message });
  }
});

app.get('/api/attendance/today', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const db = getDB();
    const [records] = await db.execute(`
      SELECT a.*, s.name as staff_name, s.department 
      FROM attendance a 
      JOIN staff s ON a.staff_id = s.id 
      WHERE a.date = ? 
      ORDER BY a.check_in DESC
    `, [today]);
    console.log(`✓ Today's attendance retrieved: ${records.length} records`);
    res.json(records);
  } catch (e) {
    console.error('✗ Error retrieving today\'s attendance:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/attendance/history', auth, async (req, res) => {
  try {
    const { staffId } = req.query;
    const db = getDB();
    let query = `
      SELECT a.*, s.name as staff_name, s.department 
      FROM attendance a 
      JOIN staff s ON a.staff_id = s.id
    `;
    let params = [];
    if (staffId) {
      query += ' WHERE a.staff_id = ?';
      params.push(staffId);
    }
    query += ' ORDER BY a.date DESC, a.check_in DESC LIMIT 100';
    const [records] = await db.execute(query, params);
    console.log(`✓ Attendance history retrieved: ${records.length} records${staffId ? ` for staff ${staffId}` : ''}`);
    res.json(records);
  } catch (e) {
    console.error('✗ Error retrieving attendance history:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/staff/:id/photo-base64', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const db = getDB();
    const [staff] = await db.execute('SELECT photo FROM staff WHERE id = ?', [id]);
    if (staff.length === 0 || !staff[0]?.photo) {
      console.log(`✗ Photo not found for staff ID: ${id}`);
      return res.status(404).json({ error: 'No photo found' });
    }
    const photoPath = staff[0].photo.startsWith('/') 
      ? path.join(path.dirname(uploadsDir), staff[0].photo.replace('/uploads/', ''))
      : path.join(__dirname, staff[0].photo);
    if (!fs.existsSync(photoPath)) {
      console.log(`✗ Photo file not found at path: ${photoPath}`);
      return res.status(404).json({ error: 'Photo file not found' });
    }
    const imageBuffer = fs.readFileSync(photoPath);
    const base64 = imageBuffer.toString('base64');
    const ext = path.extname(photoPath).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
    const dataUri = `data:${mimeType};base64,${base64}`;
    console.log(`✓ Photo base64 retrieved for staff ID: ${id}`);
    res.json({ 
      success: true,
      data: dataUri,
      staffId: id
    });
  } catch (error) {
    console.error('✗ Error retrieving photo base64:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/logo/base64', async (req, res) => {
  try {
    const logoPath = path.join(baseUploadsDir, 'logo.png');
    if (!fs.existsSync(logoPath)) {
      console.log('✗ Logo file not found at:', logoPath);
      return res.status(404).json({ error: 'Logo file not found' });
    }
    const imageBuffer = fs.readFileSync(logoPath);
    const base64 = imageBuffer.toString('base64');
    const ext = path.extname(logoPath).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
    const dataUri = `data:${mimeType};base64,${base64}`;
    console.log('✓ Logo base64 retrieved');
    res.json({ 
      success: true,
      data: dataUri
    });
  } catch (error) {
    console.error('✗ Error retrieving logo base64:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  const localIP = getLocalIP();
  console.log('\n🎉 QR Attendance System Ready');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📍 Local:   http://localhost:${PORT}`);
  console.log(`📍 Network: http://${localIP}:${PORT}`);
  if (process.env.RAILWAY_STATIC_URL) {
    console.log(`📍 Railway: https://${process.env.RAILWAY_STATIC_URL}`);
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✓ Server listening on all interfaces (0.0.0.0)');
  console.log('✓ All systems operational\n');
});