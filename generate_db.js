import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';

console.log('🔧 Creating qr_attendance.db...\n');

const db = new Database('./qr_attendance.db');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS staff (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    department TEXT,
    position TEXT,
    email TEXT,
    phone TEXT,
    role TEXT DEFAULT 'staff' CHECK (role IN ('admin', 'staff')),
    photo TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id TEXT NOT NULL,
    date DATE NOT NULL,
    check_in DATETIME,
    check_out DATETIME,
    breaks TEXT DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (staff_id) REFERENCES staff(id),
    UNIQUE (staff_id, date)
  );

  CREATE INDEX IF NOT EXISTS idx_attendance_staff_date 
  ON attendance(staff_id, date);
  
  CREATE INDEX IF NOT EXISTS idx_attendance_check_in 
  ON attendance(check_in);

  CREATE INDEX IF NOT EXISTS idx_staff_username 
  ON staff(username);
`);

console.log('✅ Tables and indexes created successfully');

console.log('🔄 Migrating existing data...');
const updated = db.prepare(`
  UPDATE attendance 
  SET breaks = '[]' 
  WHERE breaks IS NULL OR breaks = ''
`).run();
console.log(`✅ Migrated ${updated.changes} attendance records with empty breaks`);

const adminExists = db.prepare('SELECT id FROM staff WHERE username = ?').get('admin');

if (!adminExists) {
  const hash = await bcrypt.hash('admin123', 10);
  db.prepare(`
    INSERT INTO staff (id, name, username, password, role, department, position) 
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('ADMIN001', 'Administrator', 'admin', hash, 'admin', 'Management', 'System Administrator');
  console.log('✅ Default admin account created');
  console.log('   Username: admin');
  console.log('   Password: admin123\n');
} else {
  console.log('ℹ️  Admin account already exists\n');
}

const staffCount = db.prepare('SELECT COUNT(*) as count FROM staff').get();
const attendanceCount = db.prepare('SELECT COUNT(*) as count FROM attendance').get();
const attendanceWithBreaks = db.prepare(`
  SELECT COUNT(*) as count FROM attendance 
  WHERE breaks IS NOT NULL AND breaks != '[]'
`).get();

console.log('📊 Database Summary:');
console.log(`   Staff records: ${staffCount.count}`);
console.log(`   Attendance records: ${attendanceCount.count}`);
console.log(`   Records with breaks: ${attendanceWithBreaks.count}`);
console.log('\n✅ Database ready: qr_attendance.db');

db.close();