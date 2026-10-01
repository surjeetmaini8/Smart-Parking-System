const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();

const authRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'Too many authentication attempts. Try again later.' });
const passwordRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: 'Too many password reset attempts. Try again later.' });

function validateRegistration({ name, email, phone, password }) {
  if (!name || String(name).trim().length < 2 || String(name).length > 100) return 'Name must be 2-100 characters';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || String(email).length > 254) return 'Invalid email address';
  if (!phone || !/^\+?[0-9]{10,15}$/.test(String(phone))) return 'Invalid phone number';
  if (!password || String(password).length < 8 || String(password).length > 128) return 'Password must be 8-128 characters';
  return null;
}

// Register
router.post('/register', authRateLimit, async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;
    const validationError = validateRegistration({ name, email, phone, password });
    if (validationError) return res.status(400).json({ error: validationError });

    // Check if user exists
    const existingUser = await db.query(
      'SELECT * FROM users WHERE email = $1 OR phone = $2',
      [email, phone]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'User already exists' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Create user
    const result = await db.query(
      'INSERT INTO users (name, email, phone, password_hash) VALUES ($1, $2, $3, $4) RETURNING user_id, name, email, phone, role, wallet_balance',
      [name, email, phone, passwordHash]
    );

    const user = result.rows[0];

    // Generate token
    const token = jwt.sign(
      { userId: user.user_id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '2h' }
    );

    res.status(201).json({ user, token });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
router.post('/login', authRateLimit, async (req, res) => {
  try {
    const { email, password } = req.body;

    // Find user
    const result = await db.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    // Verify password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate token
    const token = jwt.sign(
      { userId: user.user_id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '2h' }
    );

    // Remove password from response
    delete user.password_hash;

    res.json({ user, token });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Get current user
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT user_id, name, email, phone, role, wallet_balance, created_at FROM users WHERE user_id = $1',
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user data' });
  }
});

// Update profile
router.put('/profile', authMiddleware, async (req, res) => {
  try {
    const { name, phone } = req.body;
    if (!name || String(name).trim().length < 2 || String(name).length > 100) {
      return res.status(400).json({ error: 'Name must be 2-100 characters' });
    }
    if (!phone || !/^\+?[0-9]{10,15}$/.test(String(phone))) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }

    const result = await db.query(
      'UPDATE users SET name = $1, phone = $2 WHERE user_id = $3 RETURNING user_id, name, email, phone, role, wallet_balance',
      [name, phone, req.user.userId]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Forgot password
router.post('/forgot-password', passwordRateLimit, async (req, res) => {
  try {
    const { email } = req.body;

    // Check if user exists
    const result = await db.query(
      'SELECT user_id, name, email, password_changed_at FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      // Don't reveal if user exists or not for security
      return res.json({ 
        success: true, 
        message: 'If an account exists with this email, you will receive password reset instructions.' 
      });
    }

    const user = result.rows[0];

    // Generate reset token (valid for 1 hour)
    const resetToken = jwt.sign(
      { userId: user.user_id, email: user.email, type: 'reset' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    // TODO: connect this token to your email/SMS provider in production.
    // Never return reset tokens from the API.
    if (process.env.NODE_ENV !== 'production') {
      console.log(`Development password reset link: ${process.env.PASSWORD_RESET_BASE_URL || 'http://localhost:4000/reset-password'}?token=${resetToken}`);
    }

    res.json({
      success: true,
      message: 'If an account exists with this email, password reset instructions have been sent.'
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to process reset request' });
  }
});

// Reset password with token
router.post('/reset-password', passwordRateLimit, async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    // Verify token
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded.type !== 'reset') {
        return res.status(401).json({ error: 'Invalid reset token' });
      }
      const userCheck = await db.query(
        'SELECT password_changed_at FROM users WHERE user_id = $1',
        [decoded.userId]
      );
      if (!userCheck.rows.length ||
          (decoded.iat * 1000) <= new Date(userCheck.rows[0].password_changed_at).getTime()) {
        return res.status(401).json({ error: 'Reset token is no longer valid' });
      }
    } catch (err) {
      return res.status(401).json({ error: 'Reset token expired or invalid' });
    }

    if (!newPassword || String(newPassword).length < 8 || String(newPassword).length > 128) {
      return res.status(400).json({ error: 'Password must be 8-128 characters' });
    }

    // Hash new password
    const passwordHash = await bcrypt.hash(newPassword, 12);

    // Update password
    await db.query(
      'UPDATE users SET password_hash = $1, password_changed_at = CURRENT_TIMESTAMP WHERE user_id = $2',
      [passwordHash, decoded.userId]
    );

    res.json({ success: true, message: 'Password reset successfully' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// Get user dashboard stats
router.get('/dashboard-stats', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;

    const stats = await db.query(`
      SELECT 
        (SELECT wallet_balance FROM users WHERE user_id = $1) as wallet_balance,
        (SELECT COUNT(*) FROM bookings WHERE user_id = $1 AND status IN ('confirmed', 'active')) as active_bookings,
        (SELECT COUNT(*) FROM bookings WHERE user_id = $1 AND status = 'completed') as completed_bookings,
        (SELECT COUNT(*) FROM bookings WHERE user_id = $1) as total_bookings,
        (SELECT COUNT(*) FROM vehicles WHERE user_id = $1) as total_vehicles,
        (SELECT COALESCE(SUM(total_amount), 0) FROM bookings WHERE user_id = $1 AND payment_status = 'paid') as total_spending,
        (SELECT COALESCE(SUM(total_amount), 0) FROM bookings WHERE user_id = $1 AND payment_status = 'paid' AND DATE(created_at) >= DATE_TRUNC('month', CURRENT_DATE)) as month_spending,
        (SELECT COUNT(*) FROM bookings WHERE user_id = $1 AND DATE(created_at) >= DATE_TRUNC('month', CURRENT_DATE)) as month_bookings
    `, [userId]);

    res.json(stats.rows[0]);
  } catch (error) {
    console.error('Get dashboard stats error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard stats' });
  }
});

module.exports = router;
