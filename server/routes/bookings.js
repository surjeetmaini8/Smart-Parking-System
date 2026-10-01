const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { sendBookingConfirmationSMS } = require('../utils/sms');
const config = require('../../config.json');

const router = express.Router();

// Create booking
router.post('/', authMiddleware, async (req, res) => {
  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');

    const { locationId, slotId, vehicleId, startTime, endTime, paymentMethod = 'razorpay' } = req.body;
    const userId = req.user.userId;

    const locationIdNum = Number(locationId);
    const slotIdNum = Number(slotId);
    const vehicleIdNum = Number(vehicleId);
    const start = new Date(startTime);
    const end = new Date(endTime);

    if (![locationIdNum, slotIdNum, vehicleIdNum].every(Number.isInteger)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid location, slot, or vehicle' });
    }
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid start or end time' });
    }

    const now = new Date();
    const maxAdvanceDays = Number(process.env.MAX_ADVANCE_BOOKING_DAYS || config.bookingSettings?.maxAdvanceBookingDays || 7);
    const maxBookingTime = new Date(now.getTime() + maxAdvanceDays * 24 * 60 * 60 * 1000);

    if (start < now) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Start time cannot be in the past' });
    }
    if (end <= start) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'End time must be after start time' });
    }
    if (end > maxBookingTime) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Bookings can only be made up to ${maxAdvanceDays} days in advance` });
    }

    if (!['cash', 'wallet', 'razorpay'].includes(paymentMethod)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid payment method' });
    }

    // Lock the slot row for the duration of this transaction. This closes the
    // classic "two users saw the same available slot" race.
    const slotCheck = await client.query(
      `SELECT s.*, l.hourly_rate, l.daily_rate, l.is_active, l.name AS location_name, l.address AS location_address
       FROM parking_slots s
       JOIN parking_locations l ON l.location_id = s.location_id
       WHERE s.slot_id = $1 AND s.location_id = $2
       FOR UPDATE`,
      [slotIdNum, locationIdNum]
    );

    if (slotCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Parking slot not found' });
    }

    const slot = slotCheck.rows[0];
    if (!slot.is_active) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Parking location is inactive' });
    }
    if (['occupied', 'maintenance', 'reserved'].includes(slot.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Slot is not currently available' });
    }

    // A vehicle can only be booked by its owner.
    const vehicleCheck = await client.query(
      'SELECT vehicle_id FROM vehicles WHERE vehicle_id = $1 AND user_id = $2',
      [vehicleIdNum, userId]
    );
    if (vehicleCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Vehicle does not belong to this user' });
    }

    // Exclusion constraint in PostgreSQL is the final concurrency guard.
    const conflictCheck = await client.query(
      `SELECT booking_id FROM bookings
       WHERE slot_id = $1
         AND status IN ('pending', 'confirmed', 'active')
         AND tstzrange(start_time, end_time, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')
       LIMIT 1`,
      [slotIdNum, start.toISOString(), end.toISOString()]
    );

    if (conflictCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Time slot already booked' });
    }

    const hours = Math.ceil((end - start) / (1000 * 60 * 60));
    const hourlyRate = Number(slot.hourly_rate);
    const dailyRate = slot.daily_rate == null ? null : Number(slot.daily_rate);
    const totalAmount = hours > 24 && dailyRate !== null
      ? Math.ceil(hours / 24) * dailyRate
      : hourlyRate * hours;

    const bookingReference = `BK${Date.now()}${uuidv4().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
    const initialStatus = paymentMethod === 'cash' ? 'confirmed' : 'pending';

    const result = await client.query(
      `INSERT INTO bookings
       (user_id, location_id, slot_id, vehicle_id, booking_reference, start_time, end_time, status, total_amount, payment_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'unpaid')
       RETURNING *`,
      [userId, locationIdNum, slotIdNum, vehicleIdNum, bookingReference, start.toISOString(), end.toISOString(), initialStatus, totalAmount]
    );

    // Hold the slot immediately for pending/confirmed bookings. A background
    // job releases abandoned pending bookings.
    await client.query(
      `UPDATE parking_slots SET status = 'reserved' WHERE slot_id = $1`,
      [slotIdNum]
    );
    await client.query(
      `UPDATE parking_locations SET available_slots = GREATEST(available_slots - 1, 0) WHERE location_id = $1`,
      [locationIdNum]
    );

    await client.query('COMMIT');

    if (global.broadcastToLocation) {
      global.broadcastToLocation(locationIdNum, 'slot-update', {
        slotId: slotIdNum,
        status: 'reserved'
      });
    }

    // Cash bookings are confirmed immediately. Notification failure must not
    // affect the booking transaction.
    if (initialStatus === 'confirmed') {
      const details = result.rows[0];
      const userDetails = (await db.query('SELECT name, phone FROM users WHERE user_id = $1', [userId])).rows[0];
      sendBookingConfirmationSMS({
        userPhone: userDetails?.phone,
        userName: userDetails?.name,
        locationName: slot.location_name,
        locationAddress: slot.location_address,
        slotNumber: slot.slot_number,
        floor: slot.floor,
        startTime: details.start_time,
        endTime: details.end_time,
        totalAmount: details.total_amount,
        bookingReference: details.booking_reference
      }).catch(err => console.error('SMS sending failed (non-blocking):', err.message));
    }

    res.status(201).json(result.rows[0]);
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    if (error && error.code === '23P01') {
      return res.status(409).json({ error: 'Time slot was booked by another user. Please choose another slot.' });
    }
    console.error('Create booking error:', error);
    res.status(500).json({ error: 'Failed to create booking' });
  } finally {
    client.release();
  }
});

// Get user bookings
router.get('/my-bookings', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { status } = req.query;

    let query = `
      SELECT b.*, 
             l.name as location_name, l.address as location_address,
             s.slot_number, s.floor,
             v.license_plate, v.make, v.model
      FROM bookings b
      JOIN parking_locations l ON b.location_id = l.location_id
      LEFT JOIN parking_slots s ON b.slot_id = s.slot_id
      LEFT JOIN vehicles v ON b.vehicle_id = v.vehicle_id
      WHERE b.user_id = $1
    `;

    const params = [userId];

    if (status) {
      query += ' AND b.status = $2';
      params.push(status);
    }

    query += ' ORDER BY b.created_at DESC';

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Get bookings error:', error);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

// Get booking details
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(
      `SELECT b.*, 
              l.name as location_name, l.address as location_address, l.latitude, l.longitude,
              s.slot_number, s.floor, s.slot_type,
              v.license_plate, v.make, v.model, v.color
       FROM bookings b
       JOIN parking_locations l ON b.location_id = l.location_id
       LEFT JOIN parking_slots s ON b.slot_id = s.slot_id
       LEFT JOIN vehicles v ON b.vehicle_id = v.vehicle_id
       WHERE b.booking_id = $1 AND b.user_id = $2`,
      [id, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get booking error:', error);
    res.status(500).json({ error: 'Failed to fetch booking' });
  }
});

// Confirm booking after payment.
// This endpoint is intentionally defensive: callers cannot confirm an unpaid booking.
router.put('/:id/confirm', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `UPDATE bookings
       SET status = 'confirmed'
       WHERE booking_id = $1
         AND user_id = $2
         AND status = 'pending'
         AND payment_status = 'paid'
       RETURNING *`,
      [id, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Booking cannot be confirmed until payment is verified' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Confirm booking error:', error);
    res.status(500).json({ error: 'Failed to confirm booking' });
  }
});

// Cancel booking
router.put('/:id/cancel', authMiddleware, async (req, res) => {
  const client = await db.pool.connect();
  
  try {
    await client.query('BEGIN');

    const { id } = req.params;
    const userId = req.user.userId;

    const booking = await client.query(
      'SELECT * FROM bookings WHERE booking_id = $1 AND user_id = $2',
      [id, userId]
    );

    if (booking.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Booking not found' });
    }

    if (!['pending', 'confirmed'].includes(booking.rows[0].status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Only pending or confirmed bookings can be cancelled' });
    }

    if (Number(booking.rows[0].paid_amount || 0) > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Paid bookings require a refund workflow before cancellation' });
    }

    const cancellationWindowHours = Number(config.bookingSettings?.cancellationWindow || 2);
    if (
      booking.rows[0].status === 'confirmed' &&
      new Date(booking.rows[0].start_time).getTime() - Date.now() < cancellationWindowHours * 60 * 60 * 1000
    ) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Confirmed bookings can only be cancelled at least ${cancellationWindowHours} hours before start time`
      });
    }

    // Update booking status
    await client.query(
      `UPDATE bookings SET status = 'cancelled' WHERE booking_id = $1`,
      [id]
    );

    // Pending bookings also hold a slot now, so every cancellable booking releases it.
    if (booking.rows[0].slot_id) {
      const released = await client.query(
        `UPDATE parking_slots s
         SET status = 'available'
         WHERE s.slot_id = $1
           AND s.status = 'reserved'
           AND NOT EXISTS (
             SELECT 1 FROM bookings b
             WHERE b.slot_id = s.slot_id
               AND b.status IN ('pending', 'confirmed', 'active')
               AND b.booking_id <> $2
           )
         RETURNING location_id`,
        [booking.rows[0].slot_id, id]
      );

      if (released.rows.length > 0) {
        await client.query(
          `UPDATE parking_locations
           SET available_slots = LEAST(total_slots, available_slots + 1)
           WHERE location_id = $1`,
          [booking.rows[0].location_id]
        );

        if (global.broadcastToLocation) {
          global.broadcastToLocation(booking.rows[0].location_id, 'slot-update', {
            slotId: booking.rows[0].slot_id,
            status: 'available'
          });
        }
      }
    }

    await client.query('COMMIT');

    res.json({ message: 'Booking cancelled successfully' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Cancel booking error:', error);
    res.status(500).json({ error: 'Failed to cancel booking' });
  } finally {
    client.release();
  }
});

module.exports = router;
