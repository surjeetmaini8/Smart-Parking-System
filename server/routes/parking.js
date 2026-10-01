const express = require('express');
const db = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// Get all parking locations
router.get('/locations', async (req, res) => {
  try {
    const { lat, lng, radius, search } = req.query;

    let query = `
      SELECT l.*, 
             ROUND((l.available_slots::numeric / NULLIF(l.total_slots, 0) * 100)::numeric, 2) as occupancy_percentage
      FROM parking_locations l
      WHERE l.is_active = true
    `;

    const params = [];
    let paramIndex = 1;

    // Add search filter if provided
    if (search) {
      query += ` AND (l.name ILIKE $${paramIndex} OR l.address ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    // Optional: Filter by distance if coordinates provided
    if (lat && lng && radius) {
      query += ` AND (
        6371 * acos(
          cos(radians($${paramIndex})) * cos(radians(latitude)) *
          cos(radians(longitude) - radians($${paramIndex + 1})) +
          sin(radians($${paramIndex})) * sin(radians(latitude))
        )
      ) <= $${paramIndex + 2}`;
      params.push(parseFloat(lat), parseFloat(lng), parseFloat(radius));
      paramIndex += 3;
    }

    query += ' ORDER BY l.name';

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Get locations error:', error);
    res.status(500).json({ error: 'Failed to fetch parking locations' });
  }
});

// Get location details
router.get('/locations/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(
      `SELECT l.*,
              u.name as owner_name,
              ROUND((l.available_slots::numeric / NULLIF(l.total_slots, 0) * 100)::numeric, 2) as occupancy_percentage
       FROM parking_locations l
       LEFT JOIN users u ON l.owner_id = u.user_id
       WHERE l.location_id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Location not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get location error:', error);
    res.status(500).json({ error: 'Failed to fetch location details' });
  }
});

// Get available slots for a location
router.get('/locations/:id/slots', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, floor, type } = req.query;

    let query = 'SELECT * FROM parking_slots WHERE location_id = $1';
    const params = [id];
    let paramIndex = 2;

    if (status) {
      query += ` AND status = $${paramIndex++}`;
      params.push(status);
    }

    if (floor) {
      query += ` AND floor = $${paramIndex++}`;
      params.push(floor);
    }

    if (type) {
      query += ` AND slot_type = $${paramIndex++}`;
      params.push(type);
    }

    query += ' ORDER BY slot_number';

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Get slots error:', error);
    res.status(500).json({ error: 'Failed to fetch slots' });
  }
});

// Check slot availability for time range
router.post('/check-availability', authMiddleware, async (req, res) => {
  try {
    const { locationId, startTime, endTime } = req.body;
    const start = new Date(startTime);
    const end = new Date(endTime);
    if (!Number.isInteger(Number(locationId)) || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      return res.status(400).json({ error: 'Invalid location or time range' });
    }

    const result = await db.query(
      `SELECT s.* FROM parking_slots s
       WHERE s.location_id = $1
       AND s.status = 'available'
       AND NOT EXISTS (
         SELECT 1 FROM bookings b
         WHERE b.slot_id = s.slot_id
           AND b.status IN ('pending', 'confirmed', 'active')
           AND tstzrange(b.start_time, b.end_time, '[)') &&
               tstzrange($2::timestamptz, $3::timestamptz, '[)')
       )
       ORDER BY s.slot_number`,
      [locationId, start.toISOString(), end.toISOString()]
    );

    res.json({
      availableCount: result.rows.length,
      slots: result.rows
    });
  } catch (error) {
    console.error('Check availability error:', error);
    res.status(500).json({ error: 'Failed to check availability' });
  }
});

module.exports = router;
