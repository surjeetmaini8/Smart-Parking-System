const express = require('express');
const db = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// Get user vehicles
router.get('/', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM vehicles WHERE user_id = $1 ORDER BY is_primary DESC, created_at DESC',
      [req.user.userId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Get vehicles error:', error);
    res.status(500).json({ error: 'Failed to fetch vehicles' });
  }
});

// Add vehicle
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { licensePlate, make, model, color, vehicleType, isPrimary } = req.body;

    // Check if license plate already exists
    const existing = await db.query(
      'SELECT * FROM vehicles WHERE license_plate = $1',
      [licensePlate]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Vehicle with this license plate already registered' });
    }

    // If setting as primary, unset other primary vehicles
    if (isPrimary) {
      await db.query(
        'UPDATE vehicles SET is_primary = false WHERE user_id = $1',
        [req.user.userId]
      );
    }

    const result = await db.query(
      `INSERT INTO vehicles (user_id, license_plate, make, model, color, vehicle_type, is_primary)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.user.userId, licensePlate, make, model, color, vehicleType, isPrimary || false]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Add vehicle error:', error);
    res.status(500).json({ error: 'Failed to add vehicle' });
  }
});

// Update vehicle
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { make, model, color, vehicleType, isPrimary } = req.body;

    // If setting as primary, unset other primary vehicles
    if (isPrimary) {
      await db.query(
        'UPDATE vehicles SET is_primary = false WHERE user_id = $1',
        [req.user.userId]
      );
    }

    const result = await db.query(
      `UPDATE vehicles 
       SET make = $1, model = $2, color = $3, vehicle_type = $4, is_primary = $5
       WHERE vehicle_id = $6 AND user_id = $7
       RETURNING *`,
      [make, model, color, vehicleType, isPrimary, id, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Vehicle not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update vehicle error:', error);
    res.status(500).json({ error: 'Failed to update vehicle' });
  }
});

// Delete vehicle
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(
      'DELETE FROM vehicles WHERE vehicle_id = $1 AND user_id = $2 RETURNING *',
      [id, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Vehicle not found' });
    }

    res.json({ message: 'Vehicle deleted successfully' });
  } catch (error) {
    console.error('Delete vehicle error:', error);
    res.status(500).json({ error: 'Failed to delete vehicle' });
  }
});

module.exports = router;
