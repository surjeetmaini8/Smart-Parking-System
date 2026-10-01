const { checkOverdueBookings, releaseExpiredPendingBookings } = require('./overdueBookings');

/**
 * Scheduler to run background jobs periodically
 */

// Run overdue bookings check every 15 minutes
const OVERDUE_CHECK_INTERVAL = 15 * 60 * 1000; // 15 minutes in milliseconds

function startScheduler() {
  console.log('Starting background job scheduler...');
  
  // Run immediately on startup
  releaseExpiredPendingBookings().catch(err => {
    console.error('Error in initial pending-booking cleanup:', err);
  });
  checkOverdueBookings().catch(err => {
    console.error('Error in initial overdue bookings check:', err);
  });
  
  // Schedule periodic checks
  setInterval(async () => {
    try {
      await releaseExpiredPendingBookings();
    } catch (error) {
      console.error('Error in scheduled pending-booking cleanup:', error);
    }
  }, 5 * 60 * 1000);

  setInterval(async () => {
    try {
      console.log('Running scheduled overdue bookings check...');
      await checkOverdueBookings();
    } catch (error) {
      console.error('Error in scheduled overdue bookings check:', error);
    }
  }, OVERDUE_CHECK_INTERVAL);
  
  console.log(`Overdue bookings check scheduled every ${OVERDUE_CHECK_INTERVAL / 60000} minutes`);
}

module.exports = { startScheduler };