const express = require('express');
const db = require('../db');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication and admin role
router.use(authMiddleware);
router.use(adminMiddleware);

// Dashboard statistics
router.get('/stats', async (req, res) => {
  try {
    const stats = await db.query(`
      SELECT 
        (SELECT COUNT(*) FROM bookings WHERE status = 'active') as active_bookings,
        (SELECT COUNT(*) FROM bookings WHERE DATE(created_at) = CURRENT_DATE) as today_bookings,
        (SELECT COALESCE(SUM(total_amount), 0) FROM bookings WHERE status = 'completed' AND DATE(actual_exit_time) = CURRENT_DATE) as today_revenue,
        (SELECT COUNT(*) FROM users WHERE role = 'user') as total_users,
        (SELECT SUM(total_slots) FROM parking_locations) as total_slots,
        (SELECT SUM(available_slots) FROM parking_locations) as available_slots,
        (SELECT COUNT(*) FROM bookings) as total_bookings,
        (SELECT COUNT(*) FROM bookings WHERE DATE(created_at) >= DATE_TRUNC('month', CURRENT_DATE)) as monthly_bookings,
        (SELECT COALESCE(SUM(total_amount), 0) FROM bookings WHERE status = 'completed') as total_revenue,
        (SELECT COALESCE(SUM(total_amount), 0) FROM bookings WHERE status = 'completed' AND DATE(actual_exit_time) >= DATE_TRUNC('month', CURRENT_DATE)) as monthly_revenue,
        (SELECT COUNT(*) FROM bookings WHERE status = 'active') as vehicles_inside,
        (SELECT COUNT(*) FROM users WHERE DATE(created_at) = CURRENT_DATE) as new_users_today
    `);

    res.json(stats.rows[0]);
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// Get all bookings
router.get('/bookings', async (req, res) => {
  try {
    const { status, locationId, date } = req.query;

    let query = `
      SELECT b.*, 
             u.name as user_name, u.email as user_email, u.phone as user_phone,
             l.name as location_name,
             s.slot_number,
             v.license_plate
      FROM bookings b
      JOIN users u ON b.user_id = u.user_id
      JOIN parking_locations l ON b.location_id = l.location_id
      LEFT JOIN parking_slots s ON b.slot_id = s.slot_id
      LEFT JOIN vehicles v ON b.vehicle_id = v.vehicle_id
      WHERE 1=1
    `;

    const params = [];
    let paramIndex = 1;

    if (status) {
      query += ` AND b.status = $${paramIndex++}`;
      params.push(status);
    }

    if (locationId) {
      query += ` AND b.location_id = $${paramIndex++}`;
      params.push(locationId);
    }

    if (date) {
      query += ` AND DATE(b.start_time) = $${paramIndex++}`;
      params.push(date);
    }

    query += ' ORDER BY b.created_at DESC LIMIT 100';

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Get bookings error:', error);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

// Get all locations with stats
router.get('/locations', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT l.*,
             u.name as owner_name,
             (SELECT COUNT(*) FROM bookings WHERE location_id = l.location_id AND status = 'active') as current_occupied,
             (SELECT COUNT(*) FROM bookings WHERE location_id = l.location_id AND DATE(created_at) = CURRENT_DATE) as today_bookings,
             ROUND((l.available_slots::numeric / NULLIF(l.total_slots, 0) * 100)::numeric, 2) as occupancy_percentage
      FROM parking_locations l
      LEFT JOIN users u ON l.owner_id = u.user_id
      ORDER BY l.name
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Get locations error:', error);
    res.status(500).json({ error: 'Failed to fetch locations' });
  }
});

// Add parking location
router.post('/locations', async (req, res) => {
  try {
    const { name, address, latitude, longitude, totalSlots, hourlyRate, dailyRate, hasCamera } = req.body;

    // Validate coordinates
    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      return res.status(400).json({ error: 'Latitude and longitude must be valid numbers' });
    }

    if (latitude < -90 || latitude > 90) {
      return res.status(400).json({ error: 'Latitude must be between -90 and 90 degrees' });
    }

    if (longitude < -180 || longitude > 180) {
      return res.status(400).json({ error: 'Longitude must be between -180 and 180 degrees' });
    }

    const result = await db.query(
      `INSERT INTO parking_locations 
       (name, address, latitude, longitude, total_slots, available_slots, hourly_rate, daily_rate, has_camera, owner_id)
       VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9)
       RETURNING *`,
      [name, address, latitude, longitude, totalSlots, hourlyRate, dailyRate, hasCamera, req.user.userId]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Add location error:', error);
    res.status(500).json({ error: 'Failed to add location' });
  }
});

// Update location
router.put('/locations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, address, hourlyRate, dailyRate, isActive, hasCamera } = req.body;

    const result = await db.query(
      `UPDATE parking_locations 
       SET name = $1, address = $2, hourly_rate = $3, daily_rate = $4, is_active = $5, has_camera = $6
       WHERE location_id = $7
       RETURNING *`,
      [name, address, hourlyRate, dailyRate, isActive, hasCamera, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Location not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update location error:', error);
    res.status(500).json({ error: 'Failed to update location' });
  }
});

// Add slots to location
router.post('/locations/:id/slots', async (req, res) => {
  const client = await db.pool.connect();
  
  try {
    await client.query('BEGIN');

    const { id } = req.params;
    const { slots } = req.body; // Array of { slotNumber, slotType, floor }

    const insertedSlots = [];

    for (const slot of slots) {
      const result = await client.query(
        `INSERT INTO parking_slots (location_id, slot_number, slot_type, floor, status)
         VALUES ($1, $2, $3, $4, 'available')
         RETURNING *`,
        [id, slot.slotNumber, slot.slotType, slot.floor]
      );
      insertedSlots.push(result.rows[0]);
    }

    // Update total slots count
    await client.query(
      `UPDATE parking_locations 
       SET total_slots = total_slots + $1, available_slots = available_slots + $1
       WHERE location_id = $2`,
      [slots.length, id]
    );

    await client.query('COMMIT');

    res.status(201).json(insertedSlots);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Add slots error:', error);
    res.status(500).json({ error: 'Failed to add slots' });
  } finally {
    client.release();
  }
});

// Get all slots with filtering
router.get('/slots', async (req, res) => {
  try {
    const { locationId, status } = req.query;

    let query = `
      SELECT s.*, 
             l.name as location_name
      FROM parking_slots s
      JOIN parking_locations l ON s.location_id = l.location_id
      WHERE 1=1
    `;

    const params = [];
    let paramIndex = 1;

    if (locationId) {
      query += ` AND s.location_id = $${paramIndex++}`;
      params.push(locationId);
    }

    if (status) {
      query += ` AND s.status = $${paramIndex++}`;
      params.push(status);
    }

    query += ' ORDER BY s.location_id, s.slot_number';

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Get slots error:', error);
    res.status(500).json({ error: 'Failed to fetch slots' });
  }
});

// Update slot status
router.put('/slots/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    // Validate status
    const validStatuses = ['available', 'occupied', 'reserved', 'maintenance'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const slotBefore = await db.query(
      'SELECT * FROM parking_slots WHERE slot_id = $1 FOR UPDATE',
      [id]
    );
    if (slotBefore.rows.length === 0) {
      return res.status(404).json({ error: 'Slot not found' });
    }

    const previousStatus = slotBefore.rows[0].status;
    const result = await db.query(
      `UPDATE parking_slots
       SET status = $1, updated_at = CURRENT_TIMESTAMP
       WHERE slot_id = $2
       RETURNING *`,
      [status, id]
    );

    if (previousStatus !== status) {
      const delta = previousStatus === 'available' && status !== 'available'
        ? -1
        : previousStatus !== 'available' && status === 'available'
          ? 1
          : 0;

      if (delta !== 0) {
        await db.query(
          `UPDATE parking_locations
           SET available_slots = GREATEST(0, LEAST(total_slots, available_slots + $1))
           WHERE location_id = $2`,
          [delta, slotBefore.rows[0].location_id]
        );
      }

      await db.query(
        `INSERT INTO occupancy_events (location_id, slot_id, previous_status, new_status, changed_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [slotBefore.rows[0].location_id, id, previousStatus, status, String(req.user.userId)]
      );
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update slot status error:', error);
    res.status(500).json({ error: 'Failed to update slot status' });
  }
});

// Delete slot
router.delete('/slots/:id', async (req, res) => {
  const client = await db.pool.connect();
  
  try {
    await client.query('BEGIN');

    const { id } = req.params;

    // Get slot info before deletion
    const slotResult = await client.query(
      'SELECT * FROM parking_slots WHERE slot_id = $1',
      [id]
    );

    if (slotResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Slot not found' });
    }

    const slot = slotResult.rows[0];

    // Delete the slot
    await client.query(
      'DELETE FROM parking_slots WHERE slot_id = $1',
      [id]
    );

    // Update location slot counts
    if (slot.status === 'available') {
      await client.query(
        `UPDATE parking_locations 
         SET total_slots = total_slots - 1, available_slots = available_slots - 1
         WHERE location_id = $1`,
        [slot.location_id]
      );
    } else {
      await client.query(
        `UPDATE parking_locations 
         SET total_slots = total_slots - 1
         WHERE location_id = $1`,
        [slot.location_id]
      );
    }

    await client.query('COMMIT');
    res.json({ message: 'Slot deleted successfully' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Delete slot error:', error);
    res.status(500).json({ error: 'Failed to delete slot' });
  } finally {
    client.release();
  }
});

// Get recent entry/exit logs
router.get('/logs', async (req, res) => {
  try {
    const { locationId, eventType } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);

    let query = `
      SELECT l.*, 
             loc.name as location_name,
             b.booking_reference
      FROM entry_exit_logs l
      JOIN parking_locations loc ON l.location_id = loc.location_id
      LEFT JOIN bookings b ON l.booking_id = b.booking_id
      WHERE 1=1
    `;

    const params = [];
    let paramIndex = 1;

    if (locationId) {
      query += ` AND l.location_id = $${paramIndex++}`;
      params.push(locationId);
    }

    if (eventType) {
      query += ` AND l.event_type = $${paramIndex++}`;
      params.push(eventType);
    }

    query += ` ORDER BY l.detected_time DESC LIMIT $${paramIndex}`;
    params.push(limit);

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Get logs error:', error);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

// Revenue report
router.get('/revenue', async (req, res) => {
  try {
    const { startDate, endDate, locationId } = req.query;

    let query = `
      SELECT 
        DATE(actual_exit_time) as date,
        l.name as location_name,
        COUNT(*) as total_bookings,
        SUM(total_amount) as total_revenue,
        AVG(total_amount) as avg_revenue
      FROM bookings b
      JOIN parking_locations l ON b.location_id = l.location_id
      WHERE b.status = 'completed'
      AND b.payment_status = 'paid'
    `;

    const params = [];
    let paramIndex = 1;

    if (startDate) {
      query += ` AND DATE(actual_exit_time) >= $${paramIndex++}`;
      params.push(startDate);
    }

    if (endDate) {
      query += ` AND DATE(actual_exit_time) <= $${paramIndex++}`;
      params.push(endDate);
    }

    if (locationId) {
      query += ` AND b.location_id = $${paramIndex++}`;
      params.push(locationId);
    }

    query += ' GROUP BY DATE(actual_exit_time), l.name ORDER BY date DESC';

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Get revenue error:', error);
    res.status(500).json({ error: 'Failed to fetch revenue data' });
  }
});

// Get all users
router.get('/users', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        user_id,
        name,
        email,
        phone,
        role,
        wallet_balance,
        created_at,
        (SELECT COUNT(*) FROM bookings WHERE user_id = users.user_id) as total_bookings,
        (SELECT COUNT(*) FROM vehicles WHERE user_id = users.user_id) as total_vehicles
      FROM users
      ORDER BY created_at DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get all vehicles
router.get('/vehicles', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        v.*,
        u.name as user_name,
        u.email as user_email,
        (SELECT COUNT(*) FROM bookings WHERE vehicle_id = v.vehicle_id) as total_bookings
      FROM vehicles v
      JOIN users u ON v.user_id = u.user_id
      ORDER BY v.created_at DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Get vehicles error:', error);
    res.status(500).json({ error: 'Failed to fetch vehicles' });
  }
});

// Analytics: Bookings Trend
router.get('/analytics/bookings-trend', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    
    const result = await db.query(`
      WITH date_series AS (
        SELECT generate_series(
          CURRENT_DATE - INTERVAL '${days - 1} days',
          CURRENT_DATE,
          '1 day'::interval
        )::date AS date
      )
      SELECT 
        TO_CHAR(ds.date, 'Mon DD') as label,
        COALESCE(COUNT(b.booking_id), 0) as value
      FROM date_series ds
      LEFT JOIN bookings b ON DATE(b.created_at) = ds.date
      GROUP BY ds.date
      ORDER BY ds.date
    `);

    res.json({
      labels: result.rows.map(row => row.label),
      values: result.rows.map(row => parseInt(row.value))
    });
  } catch (error) {
    console.error('Get bookings trend error:', error);
    res.status(500).json({ error: 'Failed to fetch bookings trend' });
  }
});

// Analytics: Revenue Trend
router.get('/analytics/revenue-trend', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    
    const result = await db.query(`
      WITH date_series AS (
        SELECT generate_series(
          CURRENT_DATE - INTERVAL '${days - 1} days',
          CURRENT_DATE,
          '1 day'::interval
        )::date AS date
      )
      SELECT 
        TO_CHAR(ds.date, 'Mon DD') as label,
        COALESCE(SUM(b.total_amount), 0) as value
      FROM date_series ds
      LEFT JOIN bookings b ON DATE(b.created_at) = ds.date AND b.payment_status = 'paid'
      GROUP BY ds.date
      ORDER BY ds.date
    `);

    res.json({
      labels: result.rows.map(row => row.label),
      values: result.rows.map(row => parseFloat(row.value))
    });
  } catch (error) {
    console.error('Get revenue trend error:', error);
    res.status(500).json({ error: 'Failed to fetch revenue trend' });
  }
});

// Analytics: Slot Occupancy
router.get('/analytics/slot-occupancy', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        COUNT(CASE WHEN status = 'occupied' THEN 1 END) as occupied,
        COUNT(CASE WHEN status = 'reserved' THEN 1 END) as reserved,
        COUNT(CASE WHEN status = 'available' THEN 1 END) as available
      FROM parking_slots
    `);

    res.json({
      occupied: parseInt(result.rows[0].occupied) || 0,
      reserved: parseInt(result.rows[0].reserved) || 0,
      available: parseInt(result.rows[0].available) || 0
    });
  } catch (error) {
    console.error('Get slot occupancy error:', error);
    res.status(500).json({ error: 'Failed to fetch slot occupancy' });
  }
});

// Analytics: Peak Hours
router.get('/analytics/peak-hours', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        CASE 
          WHEN EXTRACT(HOUR FROM start_time) BETWEEN 0 AND 3 THEN '12AM-4AM'
          WHEN EXTRACT(HOUR FROM start_time) BETWEEN 4 AND 7 THEN '4AM-8AM'
          WHEN EXTRACT(HOUR FROM start_time) BETWEEN 8 AND 11 THEN '8AM-12PM'
          WHEN EXTRACT(HOUR FROM start_time) BETWEEN 12 AND 15 THEN '12PM-4PM'
          WHEN EXTRACT(HOUR FROM start_time) BETWEEN 16 AND 19 THEN '4PM-8PM'
          ELSE '8PM-12AM'
        END as time_slot,
        COUNT(*) as count
      FROM bookings
      WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY 1
      ORDER BY 
        MIN(CASE 
          WHEN EXTRACT(HOUR FROM start_time) BETWEEN 0 AND 3 THEN 1
          WHEN EXTRACT(HOUR FROM start_time) BETWEEN 4 AND 7 THEN 2
          WHEN EXTRACT(HOUR FROM start_time) BETWEEN 8 AND 11 THEN 3
          WHEN EXTRACT(HOUR FROM start_time) BETWEEN 12 AND 15 THEN 4
          WHEN EXTRACT(HOUR FROM start_time) BETWEEN 16 AND 19 THEN 5
          ELSE 6
        END)
    `);

    const labels = ['12AM-4AM', '4AM-8AM', '8AM-12PM', '12PM-4PM', '4PM-8PM', '8PM-12AM'];
    const dataMap = {};
    result.rows.forEach(row => {
      dataMap[row.time_slot] = parseInt(row.count);
    });

    res.json({
      labels: labels,
      values: labels.map(label => dataMap[label] || 0)
    });
  } catch (error) {
    console.error('Get peak hours error:', error);
    res.status(500).json({ error: 'Failed to fetch peak hours' });
  }
});

module.exports = router;
