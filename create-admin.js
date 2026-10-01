const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'smart_parking',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD
});

async function createAdmin() {
  try {
    const email = process.env.ADMIN_EMAIL || 'admin@smartparking.com';
    const password = process.env.ADMIN_PASSWORD;
    const name = process.env.ADMIN_NAME || 'Admin User';
    const phone = process.env.ADMIN_PHONE;

    if (!password || password.length < 12) {
      throw new Error('Set ADMIN_PASSWORD to a strong password of at least 12 characters');
    }
    if (!phone || !/^\+?[0-9]{10,15}$/.test(phone)) {
      throw new Error('Set ADMIN_PHONE to a valid phone number');
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Check if admin exists
    const existing = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

    if (existing.rows.length > 0) {
      // Update existing admin
      await pool.query(
        'UPDATE users SET password_hash = $1, role = $2 WHERE email = $3',
        [passwordHash, 'admin', email]
      );
      console.log('✅ Admin user updated successfully!');
    } else {
      // Create new admin
      await pool.query(
        'INSERT INTO users (name, email, phone, password_hash, role) VALUES ($1, $2, $3, $4, $5)',
        [name, email, phone, passwordHash, 'admin']
      );
      console.log('✅ Admin user created successfully!');
    }

    console.log(`\n📧 Admin email: ${email}`);
    console.log('🔑 Password was set from ADMIN_PASSWORD and is not printed.');

    await pool.end();
  } catch (error) {
    console.error('❌ Error:', error.message);
    await pool.end();
    process.exit(1);
  }
}

createAdmin();
