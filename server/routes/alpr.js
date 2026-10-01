const express = require('express');
const axios = require('axios');
const multer = require('multer');
const FormData = require('form-data');
const db = require('../db');
const { alprAuthMiddleware } = require('../middleware/auth');
const config = require('../../config.json');

const router = express.Router();

// Configure multer for memory storage
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

// Process entry
router.post('/entry', alprAuthMiddleware, async (req, res) => {
  const client = await db.pool.connect();
  
  try {
    await client.query('BEGIN');

    const { licensePlate, locationId, imagePath, cameraId, confidenceScore } = req.body;

    const normalizedPlate = String(licensePlate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const confidence = Number(confidenceScore);
    const minimumConfidence = Number(config.cameraSettings?.confidenceThreshold ?? 0.7);

    if (!normalizedPlate || normalizedPlate.length < 4) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid license plate' });
    }
    if (!Number.isFinite(confidence) || confidence < minimumConfidence) {
      await client.query('ROLLBACK');
      return res.status(422).json({ error: 'License plate confidence is below the safety threshold', threshold: minimumConfidence });
    }

    // Find active booking for this vehicle
    const booking = await client.query(
      `SELECT b.*, v.license_plate
       FROM bookings b
       JOIN vehicles v ON b.vehicle_id = v.vehicle_id
       WHERE v.license_plate = $1 
       AND b.location_id = $2
       AND b.status = 'confirmed'
       AND b.start_time <= NOW()
       AND b.end_time >= NOW()
       ORDER BY b.created_at DESC
       LIMIT 1`,
      [normalizedPlate, locationId]
    );

    if (booking.rows.length === 0) {
      // Never interpret an entry-camera detection as an exit. An active
      // overdue booking must be handled by the exit camera or staff.
      // Log unverified entry
      await client.query(
        `INSERT INTO entry_exit_logs 
         (location_id, license_plate, event_type, image_path, camera_id, confidence_score, is_verified)
         VALUES ($1, $2, 'entry', $3, $4, $5, false)`,
        [locationId, normalizedPlate, imagePath, cameraId, confidence]
      );

      await client.query('COMMIT');
      return res.status(409).json({
        error: 'No valid booking found for entry',
        licensePlate: normalizedPlate
      });
    }

    const bookingData = booking.rows[0];

    // Update booking with actual entry time
    await client.query(
      `UPDATE bookings 
       SET actual_entry_time = NOW(), status = 'active' 
       WHERE booking_id = $1`,
      [bookingData.booking_id]
    );

    // Update slot status
    await client.query(
      `UPDATE parking_slots 
       SET status = 'occupied' 
       WHERE slot_id = $1`,
      [bookingData.slot_id]
    );

    // Log verified entry
    await client.query(
      `INSERT INTO entry_exit_logs 
       (booking_id, location_id, license_plate, event_type, image_path, camera_id, confidence_score, is_verified)
       VALUES ($1, $2, $3, 'entry', $4, $5, $6, true)`,
      [bookingData.booking_id, locationId, normalizedPlate, imagePath, cameraId, confidence]
    );

    await client.query('COMMIT');

    // Broadcast real-time update
    if (global.broadcastToLocation) {
      global.broadcastToLocation(locationId, 'vehicle-entry', {
        bookingId: bookingData.booking_id,
        slotNumber: bookingData.slot_number
      });
    }

    res.json({ 
      success: true,
      message: 'Entry verified',
      booking: bookingData 
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Entry processing error:', error);
    res.status(500).json({ error: 'Failed to process entry' });
  } finally {
    client.release();
  }
});

// Process exit
router.post('/exit', alprAuthMiddleware, async (req, res) => {
  const client = await db.pool.connect();
  
  try {
    await client.query('BEGIN');

    const { licensePlate, locationId, imagePath, cameraId, confidenceScore } = req.body;

    const normalizedPlate = String(licensePlate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const confidence = Number(confidenceScore);
    const minimumConfidence = Number(config.cameraSettings?.confidenceThreshold ?? 0.7);
    if (!normalizedPlate || normalizedPlate.length < 4) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid license plate' });
    }
    if (!Number.isFinite(confidence) || confidence < minimumConfidence) {
      await client.query('ROLLBACK');
      return res.status(422).json({ error: 'License plate confidence is below the safety threshold', threshold: minimumConfidence });
    }

    // Find active booking
    const booking = await client.query(
      `SELECT b.*, v.license_plate, l.hourly_rate, u.wallet_balance
       FROM bookings b
       JOIN vehicles v ON b.vehicle_id = v.vehicle_id
       JOIN parking_locations l ON b.location_id = l.location_id
       JOIN users u ON b.user_id = u.user_id
       WHERE v.license_plate = $1 
       AND b.location_id = $2
       AND b.status = 'active'
       AND b.actual_entry_time IS NOT NULL
       ORDER BY b.actual_entry_time DESC
       LIMIT 1`,
      [normalizedPlate, locationId]
    );

    if (booking.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ 
        error: 'No active parking session found',
        licensePlate: normalizedPlate
      });
    }

    const bookingData = booking.rows[0];
    const exitTime = new Date();
    const entryTime = new Date(bookingData.actual_entry_time);
    const bookedEndTime = new Date(bookingData.end_time);

    // Calculate actual parking duration
    const actualHours = Math.ceil((exitTime - entryTime) / (1000 * 60 * 60));
    const bookedHours = Math.ceil((bookedEndTime - entryTime) / (1000 * 60 * 60));

    // Calculate additional charges if overstayed
    let additionalAmount = 0;
    let overtimeHours = 0;
    
    if (actualHours > bookedHours) {
      overtimeHours = actualHours - bookedHours;
      // Charge 1.5x rate for overstay
      additionalAmount = overtimeHours * bookingData.hourly_rate * 1.5;
    }

    const finalAmount = parseFloat(bookingData.total_amount) + additionalAmount;

    // Update booking
    await client.query(
      `UPDATE bookings 
       SET actual_exit_time = $1, 
           status = 'completed',
           total_amount = $2
       WHERE booking_id = $3`,
      [exitTime, finalAmount, bookingData.booking_id]
    );

    // Free the slot only when no later reservation is holding it.
    const slotRelease = await client.query(
      `UPDATE parking_slots s
       SET status = CASE
         WHEN EXISTS (
           SELECT 1 FROM bookings b
           WHERE b.slot_id = s.slot_id
             AND b.booking_id <> $2
             AND b.status IN ('pending', 'confirmed', 'active')
             AND b.end_time > NOW()
         ) THEN 'reserved'
         ELSE 'available'
       END
       WHERE s.slot_id = $1
       RETURNING status`,
      [bookingData.slot_id, bookingData.booking_id]
    );

    if (slotRelease.rows[0]?.status === 'available') {
      await client.query(
        `UPDATE parking_locations
         SET available_slots = LEAST(total_slots, available_slots + 1)
         WHERE location_id = $1`,
        [locationId]
      );
    }

    // Log exit
    await client.query(
      `INSERT INTO entry_exit_logs 
       (booking_id, location_id, license_plate, event_type, image_path, camera_id, confidence_score, is_verified)
       VALUES ($1, $2, $3, 'exit', $4, $5, $6, true)`,
      [bookingData.booking_id, locationId, normalizedPlate, imagePath, cameraId, confidence]
    );

    await client.query('COMMIT');

    // Broadcast real-time update
    if (global.broadcastToLocation) {
      global.broadcastToLocation(locationId, 'vehicle-exit', {
        bookingId: bookingData.booking_id,
        slotNumber: bookingData.slot_number,
        slotStatus: slotRelease.rows[0]?.status || 'available',
        additionalCharges: additionalAmount,
        overtimeHours: overtimeHours
      });
    }

    res.json({ 
      success: true,
      message: 'Exit processed',
      booking: {
        ...bookingData,
        actual_exit_time: exitTime,
        final_amount: finalAmount,
        additional_charges: additionalAmount,
        overtime_hours: overtimeHours,
        requires_additional_payment: additionalAmount > 0
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Exit processing error:', error);
    res.status(500).json({ error: 'Failed to process exit' });
  } finally {
    client.release();
  }
});

// Process additional payment for overtime
router.post('/exit-payment', authMiddleware, async (req, res) => {
  const client = await db.pool.connect();
  
  try {
    await client.query('BEGIN');

    const { bookingId, paymentMethod } = req.body;
    const userId = req.user.userId;

    // Get booking details
    const booking = await client.query(
      `SELECT b.*, l.hourly_rate, u.wallet_balance
       FROM bookings b
       JOIN parking_locations l ON b.location_id = l.location_id
       JOIN users u ON b.user_id = u.user_id
       WHERE b.booking_id = $1 AND b.user_id = $2`,
      [bookingId, userId]
    );

    if (booking.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Booking not found' });
    }

    const bookingData = booking.rows[0];
    
    // Check if booking is completed and has additional charges
    if (bookingData.status !== 'completed') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Booking is not completed yet' });
    }

    // Calculate additional charges if not already calculated
    let additionalAmount = 0;
    if (bookingData.actual_exit_time && bookingData.end_time) {
      const exitTime = new Date(bookingData.actual_exit_time);
      const entryTime = new Date(bookingData.actual_entry_time);
      const bookedEndTime = new Date(bookingData.end_time);
      
      const actualHours = Math.ceil((exitTime - entryTime) / (1000 * 60 * 60));
      const bookedHours = Math.ceil((bookedEndTime - entryTime) / (1000 * 60 * 60));
      
      if (actualHours > bookedHours) {
        const overtimeHours = actualHours - bookedHours;
        additionalAmount = overtimeHours * bookingData.hourly_rate * 1.5;
      }
    }

    // Check if additional payment is already made
    const totalPaid = parseFloat(bookingData.paid_amount || 0);
    const totalAmount = parseFloat(bookingData.total_amount || 0);
    const remainingAmount = totalAmount - totalPaid;

    if (remainingAmount <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No additional payment required' });
    }

    let paymentStatus = 'success';
    let transactionId = `TXN${Date.now()}${require('uuid').v4().substring(0, 8)}`;

    if (!['wallet', 'cash'].includes(paymentMethod)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Unsupported exit payment method' });
    }

    if (paymentMethod === 'wallet') {
      const walletUpdate = await client.query(
        `UPDATE users
         SET wallet_balance = wallet_balance - $1
         WHERE user_id = $2 AND wallet_balance >= $1
         RETURNING wallet_balance`,
        [remainingAmount, userId]
      );

      if (walletUpdate.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Insufficient wallet balance', requiredAmount: remainingAmount });
      }

      transactionId = `WALLET${Date.now()}${require('uuid').v4().substring(0, 8)}`;
    } else {
      // Cash is only recorded as pending; it is not revenue until collected.
      paymentStatus = 'pending';
      transactionId = `CASH${Date.now()}${require('uuid').v4().substring(0, 8)}`;
    }

    // Create payment record
    const payment = await client.query(
      `INSERT INTO payments (booking_id, user_id, amount, payment_method, transaction_id, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [bookingId, userId, remainingAmount, paymentMethod, transactionId, paymentStatus]
    );

    // Only successful wallet payments increase paid_amount.
    if (paymentStatus === 'success') {
      await client.query(
        `UPDATE bookings
         SET paid_amount = paid_amount + $1,
             payment_status = CASE
               WHEN paid_amount + $1 >= total_amount THEN 'paid'
               ELSE 'partial'
             END
         WHERE booking_id = $2`,
        [remainingAmount, bookingId]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({
      ...payment.rows[0],
      message: paymentMethod === 'wallet' ? 'Additional payment successful. Amount deducted from wallet.' : 
               paymentMethod === 'cash' ? 'Additional payment recorded. Pay cash at exit.' :
               'Additional payment processed successfully.'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Additional payment error:', error);
    res.status(500).json({ error: 'Additional payment processing failed' });
  } finally {
    client.release();
  }
});

// Recognize license plate (proxy to OCR service)
router.post('/recognize', alprAuthMiddleware, upload.single('image'), async (req, res) => {
  try {
    const ocrServiceUrl = process.env.OCR_SERVICE_URL || 'http://localhost:5000';
    
    if (!req.file) {
      return res.status(400).json({ error: 'No image provided' });
    }

    // Create form data to send to OCR service
    const formData = new FormData();
    formData.append('image', req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype
    });

    const response = await axios.post(`${ocrServiceUrl}/recognize`, formData, {
      headers: formData.getHeaders(),
      timeout: 10000
    });

    res.json(response.data);
  } catch (error) {
    console.error('OCR recognition error:', error.message);
    res.status(500).json({ 
      error: 'License plate recognition failed',
      details: error.message 
    });
  }
});

module.exports = router;