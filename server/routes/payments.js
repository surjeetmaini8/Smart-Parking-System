const express = require('express');
const { v4: uuidv4 } = require('uuid');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const db = require('../db');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const { sendBookingConfirmationSMS } = require('../utils/sms');

const router = express.Router();

// Initialize Razorpay
const razorpayConfigured = Boolean(
  process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET
);
const razorpay = razorpayConfigured
  ? new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET
    })
  : null;

// Create Razorpay order. Amount is always calculated server-side.
router.post('/create-order', authMiddleware, async (req, res) => {
  if (!razorpay) return res.status(503).json({ error: 'Payment gateway is not configured' });
  try {
    const { bookingId } = req.body;

    const bookingResult = await db.query(
      `SELECT booking_id, total_amount, paid_amount, status, payment_status
       FROM bookings
       WHERE booking_id = $1 AND user_id = $2`,
      [bookingId, req.user.userId]
    );

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingResult.rows[0];
    if (!['pending', 'confirmed'].includes(booking.status)) {
      return res.status(400).json({ error: 'Booking is not payable in its current state' });
    }

    const amount = Number(booking.total_amount) - Number(booking.paid_amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'No payment is due for this booking' });
    }

    const options = {
      amount: Math.round(amount * 100),
      currency: 'INR',
      receipt: `order_${bookingId}_${Date.now()}`,
      notes: {
        booking_id: String(bookingId),
        user_id: String(req.user.userId)
      }
    };

    const order = await razorpay.orders.create(options);

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID
    });
  } catch (error) {
    console.error('Create order error:', error);
    res.status(500).json({ error: 'Failed to create payment order' });
  }
});

// Verify Razorpay payment.
router.post('/verify-payment', authMiddleware, async (req, res) => {
  if (!razorpay) return res.status(503).json({ error: 'Payment gateway is not configured' });
  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');

    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      bookingId
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !bookingId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Missing payment verification fields' });
    }

    const bookingResult = await client.query(
      `SELECT b.*, p.payment_id AS existing_payment_id, p.status AS existing_payment_status
       FROM bookings b
       LEFT JOIN payments p
         ON p.booking_id = b.booking_id
        AND p.transaction_id = $1
       WHERE b.booking_id = $2 AND b.user_id = $3
       LIMIT 1`,
      [razorpay_payment_id, bookingId, req.user.userId]
    );

    if (bookingResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingResult.rows[0];
    const expectedAmountPaise = Math.round((Number(booking.total_amount) - Number(booking.paid_amount || 0)) * 100);

    // Idempotency: a repeated browser callback should not charge/credit twice.
    if (booking.existing_payment_id && booking.existing_payment_status === 'success') {
      await client.query('COMMIT');
      return res.json({ success: true, message: 'Payment was already verified' });
    }

    const sign = `${razorpay_order_id}|${razorpay_payment_id}`;
    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!secret) {
      await client.query('ROLLBACK');
      return res.status(503).json({ error: 'Payment gateway is not configured' });
    }

    const expectedSign = crypto.createHmac('sha256', secret).update(sign).digest('hex');
    const signaturesMatch =
      razorpay_signature.length === expectedSign.length &&
      crypto.timingSafeEqual(Buffer.from(razorpay_signature), Buffer.from(expectedSign));
    if (!signaturesMatch) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid payment signature' });
    }

    // Fetch the order from Razorpay; do not trust client-supplied amount/order metadata.
    const order = await razorpay.orders.fetch(razorpay_order_id);
    if (
      order.notes?.booking_id !== String(bookingId) ||
      order.notes?.user_id !== String(req.user.userId) ||
      Number(order.amount) !== expectedAmountPaise ||
      order.currency !== 'INR'
    ) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Payment order does not match the booking' });
    }

    const paymentDetails = await razorpay.payments.fetch(razorpay_payment_id);
    if (
      Number(paymentDetails.amount) !== expectedAmountPaise ||
      paymentDetails.currency !== 'INR' ||
      paymentDetails.status !== 'captured'
    ) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Payment amount or status is invalid' });
    }

    const payment = await client.query(
      `INSERT INTO payments
       (booking_id, user_id, amount, payment_method, transaction_id, status, gateway_response)
       VALUES ($1, $2, $3, 'razorpay', $4, 'success', $5)
       RETURNING *`,
      [
        bookingId,
        req.user.userId,
        expectedAmountPaise / 100,
        razorpay_payment_id,
        JSON.stringify({ order_id: razorpay_order_id, payment_id: razorpay_payment_id })
      ]
    );

    const updated = await client.query(
      `UPDATE bookings
       SET paid_amount = paid_amount + $1,
           payment_status = CASE WHEN paid_amount + $1 >= total_amount THEN 'paid' ELSE 'partial' END,
           status = CASE WHEN status = 'pending' THEN 'confirmed' ELSE status END
       WHERE booking_id = $2
       RETURNING *`,
      [expectedAmountPaise / 100, bookingId]
    );

    await client.query('COMMIT');

    if (global.broadcastToLocation) {
      global.broadcastToLocation(booking.location_id, 'slot-update', {
        slotId: booking.slot_id,
        status: 'reserved'
      });
    }

    res.json({
      success: true,
      message: 'Payment verified successfully',
      payment: payment.rows[0],
      booking: updated.rows[0]
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Verify payment error:', error);
    res.status(500).json({ error: 'Payment verification failed' });
  } finally {
    client.release();
  }
});

// Record a non-gateway payment (wallet or cash).
router.post('/', authMiddleware, async (req, res) => {
  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');

    const { bookingId, paymentMethod } = req.body;
    const userId = req.user.userId;

    if (!['wallet', 'cash'].includes(paymentMethod)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Use the Razorpay flow for online payments' });
    }

    const bookingResult = await client.query(
      `SELECT * FROM bookings
       WHERE booking_id = $1 AND user_id = $2
       FOR UPDATE`,
      [bookingId, userId]
    );
    if (bookingResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingResult.rows[0];
    if (!['pending', 'confirmed'].includes(booking.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Booking is not payable in its current state' });
    }

    const amount = Number(booking.total_amount) - Number(booking.paid_amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No payment is due for this booking' });
    }

    let paymentStatus = 'success';
    let transactionId = `${paymentMethod.toUpperCase()}_${uuidv4()}`;

    if (paymentMethod === 'wallet') {
      const wallet = await client.query(
        `UPDATE users
         SET wallet_balance = wallet_balance - $1
         WHERE user_id = $2 AND wallet_balance >= $1
         RETURNING wallet_balance`,
        [amount, userId]
      );

      if (wallet.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Insufficient wallet balance' });
      }
    } else {
      paymentStatus = 'pending'; // Cash is collected at entry/exit by staff.
    }

    const payment = await client.query(
      `INSERT INTO payments
       (booking_id, user_id, amount, payment_method, transaction_id, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [bookingId, userId, amount, paymentMethod, transactionId, paymentStatus]
    );

    const updated = await client.query(
      `UPDATE bookings
       SET paid_amount = paid_amount + $1,
           payment_status = CASE
             WHEN $2 = 'success' AND paid_amount + $1 >= total_amount THEN 'paid'
             WHEN $2 = 'success' THEN 'partial'
             ELSE payment_status
           END,
           status = CASE
             WHEN $2 = 'success' AND status = 'pending' THEN 'confirmed'
             ELSE status
           END
       WHERE booking_id = $3
       RETURNING *`,
      [amount, paymentStatus, bookingId]
    );

    await client.query('COMMIT');

    if (paymentStatus === 'success' && global.broadcastToLocation) {
      global.broadcastToLocation(booking.location_id, 'slot-update', {
        slotId: booking.slot_id,
        status: 'reserved'
      });
    }

    res.status(201).json({
      ...payment.rows[0],
      booking: updated.rows[0],
      message: paymentMethod === 'wallet'
        ? 'Payment successful. Amount deducted from wallet.'
        : 'Booking confirmed. Pay cash at the parking facility.'
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Payment error:', error);
    res.status(500).json({ error: 'Payment processing failed' });
  } finally {
    client.release();
  }
});

// Confirm a cash payment collected by staff.
router.post('/:paymentId/confirm-cash', authMiddleware, adminMiddleware, async (req, res) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const payment = await client.query(
      `SELECT p.*, b.total_amount, b.paid_amount
       FROM payments p
       JOIN bookings b ON b.booking_id = p.booking_id
       WHERE p.payment_id = $1
       FOR UPDATE`,
      [req.params.paymentId]
    );

    if (payment.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Payment not found' });
    }

    const pmt = payment.rows[0];
    if (pmt.payment_method !== 'cash' || pmt.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Payment is not a pending cash payment' });
    }

    await client.query(
      `UPDATE payments SET status = 'success' WHERE payment_id = $1`,
      [req.params.paymentId]
    );

    await client.query(
      `UPDATE bookings
       SET paid_amount = LEAST(total_amount, paid_amount + $1),
           payment_status = CASE
             WHEN paid_amount + $1 >= total_amount THEN 'paid'
             ELSE 'partial'
           END
       WHERE booking_id = $2`,
      [pmt.amount, pmt.booking_id]
    );

    await client.query('COMMIT');
    res.json({ success: true, message: 'Cash payment confirmed' });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Confirm cash payment error:', error);
    res.status(500).json({ error: 'Failed to confirm cash payment' });
  } finally {
    client.release();
  }
});

// Get payment history
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT p.*, 
              b.booking_reference,
              l.name as location_name
       FROM payments p
       JOIN bookings b ON p.booking_id = b.booking_id
       JOIN parking_locations l ON b.location_id = l.location_id
       WHERE p.user_id = $1
       ORDER BY p.payment_date DESC`,
      [req.user.userId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Get payment history error:', error);
    res.status(500).json({ error: 'Failed to fetch payment history' });
  }
});

// Add funds to wallet
router.post('/wallet/add', authMiddleware, async (req, res) => {
  if (process.env.ENABLE_TEST_WALLET_TOPUP !== 'true') {
    return res.status(403).json({ error: 'Direct wallet top-up is disabled. Use the payment gateway.' });
  }
  const client = await db.pool.connect();
  
  try {
    await client.query('BEGIN');

    const amount = Number(req.body.amount);
    const userId = req.user.userId;

    if (!Number.isFinite(amount) || amount <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // If payment method is provided, verify the payment first
    // Otherwise, just add funds (for testing/admin purposes)
    
    // Update wallet balance
    const result = await client.query(
      `UPDATE users 
       SET wallet_balance = wallet_balance + $1 
       WHERE user_id = $2 
       RETURNING wallet_balance`,
      [amount, userId]
    );

    await client.query('COMMIT');

    res.json({ 
      message: 'Funds added successfully',
      newBalance: result.rows[0].wallet_balance 
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Add wallet funds error:', error);
    res.status(500).json({ error: 'Failed to add funds' });
  } finally {
    client.release();
  }
});

// Create Razorpay order for wallet top-up
router.post('/wallet/create-topup-order', authMiddleware, async (req, res) => {
  if (!razorpay) return res.status(503).json({ error: 'Payment gateway is not configured' });
  try {
    const amount = Number(req.body.amount);
    const maxTopup = Number(process.env.MAX_WALLET_TOPUP || 50000);

    if (!Number.isFinite(amount) || amount <= 0 || amount > maxTopup) {
      return res.status(400).json({ error: `Top-up must be between ₹0.01 and ₹${maxTopup}` });
    }

    // Create Razorpay order
    const options = {
      amount: Math.round(amount * 100), // Amount in paise
      currency: 'INR',
      receipt: `wallet_topup_${req.user.userId}_${Date.now()}`,
      notes: {
        user_id: req.user.userId,
        type: 'wallet_topup'
      }
    };

    const order = await razorpay.orders.create(options);

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID
    });
  } catch (error) {
    console.error('Create wallet topup order error:', error);
    res.status(500).json({ error: 'Failed to create wallet topup order' });
  }
});

// Verify wallet top-up payment
router.post('/wallet/verify-topup', authMiddleware, async (req, res) => {
  if (!razorpay) return res.status(503).json({ error: 'Payment gateway is not configured' });
  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');

    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Missing payment verification fields' });
    }

    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!secret) {
      await client.query('ROLLBACK');
      return res.status(503).json({ error: 'Payment gateway is not configured' });
    }

    const sign = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSign = crypto.createHmac('sha256', secret).update(sign).digest('hex');
    if (
      razorpay_signature.length !== expectedSign.length ||
      !crypto.timingSafeEqual(Buffer.from(razorpay_signature), Buffer.from(expectedSign))
    ) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid payment signature' });
    }

    const order = await razorpay.orders.fetch(razorpay_order_id);
    if (
      order.notes?.type !== 'wallet_topup' ||
      order.notes?.user_id !== String(req.user.userId)
    ) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Payment order does not match this wallet' });
    }

    const paymentDetails = await razorpay.payments.fetch(razorpay_payment_id);
    if (Number(paymentDetails.amount) !== Number(order.amount) || paymentDetails.currency !== 'INR' ||
        paymentDetails.status !== 'captured') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Payment amount or status is invalid' });
    }
    const amount = Number(order.amount) / 100;

    const inserted = await client.query(
      `INSERT INTO wallet_transactions
       (user_id, amount, transaction_id, status, payment_method, gateway_response)
       VALUES ($1, $2, $3, 'success', 'razorpay', $4)
       ON CONFLICT (transaction_id) DO NOTHING
       RETURNING wallet_transaction_id`,
      [req.user.userId, amount, razorpay_payment_id,
       JSON.stringify({ order_id: razorpay_order_id, payment_id: razorpay_payment_id, type: 'wallet_topup' })]
    );

    if (inserted.rows.length > 0) {
      await client.query(
        `UPDATE users
         SET wallet_balance = wallet_balance + $1
         WHERE user_id = $2`,
        [amount, req.user.userId]
      );
    }

    const result = await client.query(
      'SELECT wallet_balance FROM users WHERE user_id = $1',
      [req.user.userId]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      message: inserted.rows.length ? 'Wallet topped up successfully' : 'Wallet top-up was already applied',
      newBalance: result.rows[0].wallet_balance
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Verify wallet topup error:', error);
    res.status(500).json({ error: 'Wallet topup verification failed' });
  } finally {
    client.release();
  }
});

module.exports = router;
