const db = require('../db');

/**
 * Check for overdue bookings and handle them appropriately
 * This function runs periodically to check for bookings that have exceeded their end time
 */
async function checkOverdueBookings() {
  const client = await db.pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Find active bookings that have exceeded their end time by more than 30 minutes
    // and haven't been marked as completed
    const overdueBookings = await client.query(`
      SELECT b.*, 
             v.license_plate,
             l.hourly_rate,
             u.user_id,
             u.phone as user_phone,
             u.name as user_name
      FROM bookings b
      JOIN vehicles v ON b.vehicle_id = v.vehicle_id
      JOIN parking_locations l ON b.location_id = l.location_id
      JOIN users u ON b.user_id = u.user_id
      WHERE b.status = 'active'
      AND b.end_time < NOW() - INTERVAL '30 minutes'
      AND b.actual_entry_time IS NOT NULL
      AND b.actual_exit_time IS NULL
      ORDER BY b.end_time ASC
    `);
    
    console.log(`Found ${overdueBookings.rows.length} overdue bookings`);
    
    for (const booking of overdueBookings.rows) {
      try {
        // Calculate additional charges for overstaying
        const exitTime = new Date();
        const entryTime = new Date(booking.actual_entry_time);
        const bookedEndTime = new Date(booking.end_time);
        
        // Calculate actual parking duration in hours
        const actualHours = Math.ceil((exitTime - entryTime) / (1000 * 60 * 60));
        const bookedHours = Math.ceil((bookedEndTime - entryTime) / (1000 * 60 * 60));
        
        // Calculate additional charges if overstayed
        let additionalAmount = 0;
        let overtimeHours = 0;
        
        if (actualHours > bookedHours) {
          overtimeHours = actualHours - bookedHours;
          // Charge 1.5x rate for overstay
          additionalAmount = overtimeHours * booking.hourly_rate * 1.5;
        }
        
        const finalAmount = parseFloat(booking.total_amount) + additionalAmount;
        
        // Update booking as completed with exit time as current time
        await client.query(`
          UPDATE bookings 
          SET actual_exit_time = $1, 
              status = 'completed',
              total_amount = $2
          WHERE booking_id = $3`,
          [exitTime, finalAmount, booking.booking_id]
        );
        
        // Free up the slot
        await client.query(`
          UPDATE parking_slots 
          SET status = 'available' 
          WHERE slot_id = $1`,
          [booking.slot_id, booking.booking_id]
        );
        
        // Update available slots count
        await client.query(`
          UPDATE parking_locations 
          SET available_slots = available_slots + 1 
          WHERE location_id = $1`,
          [booking.location_id]
        );
        
        // Log automatic exit
        await client.query(`
          INSERT INTO entry_exit_logs 
          (booking_id, location_id, license_plate, event_type, is_verified)
          VALUES ($1, $2, $3, 'exit', true)`,
          [booking.booking_id, booking.location_id, booking.license_plate]
        );
        
        console.log(`Processed overdue booking ${booking.booking_id} for vehicle ${booking.license_plate}`);
      } catch (bookingError) {
        console.error(`Error processing overdue booking ${booking.booking_id}:`, bookingError);
      }
    }
    
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error checking overdue bookings:', error);
  } finally {
    client.release();
  }
}


/**
 * Release unpaid/pending reservations that were abandoned.
 * Pending bookings are now holding a slot, so they must have a TTL.
 */
async function releaseExpiredPendingBookings() {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const expired = await client.query(
      `SELECT booking_id, slot_id, location_id
       FROM bookings
       WHERE status = 'pending'
         AND created_at < NOW() - INTERVAL '15 minutes'
       FOR UPDATE`
    );

    for (const booking of expired.rows) {
      await client.query(
        `UPDATE bookings SET status = 'cancelled' WHERE booking_id = $1`,
        [booking.booking_id]
      );

      const slot = await client.query(
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
        [booking.slot_id]
      );

      if (slot.rows.length) {
        await client.query(
          `UPDATE parking_locations
           SET available_slots = LEAST(total_slots, available_slots + 1)
           WHERE location_id = $1`,
          [booking.location_id]
        );
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Error releasing expired pending bookings:', error);
  } finally {
    client.release();
  }
}

module.exports = { checkOverdueBookings, releaseExpiredPendingBookings };