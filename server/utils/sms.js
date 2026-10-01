const twilio = require('twilio');

// Initialize Twilio client
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;

let twilioClient = null;

// Debug: Log what we're getting from env
console.log('🔍 Twilio Config Check:');
console.log('  Account SID:', accountSid ? `${accountSid.substring(0, 6)}...` : 'MISSING');
console.log('  Auth Token:', authToken ? 'SET (hidden)' : 'MISSING');
console.log('  Phone Number:', twilioPhoneNumber || 'MISSING');

// Only initialize if credentials are available
if (accountSid && authToken && twilioPhoneNumber) {
  try {
    twilioClient = twilio(accountSid, authToken);
    console.log('✅ Twilio SMS service initialized successfully');
  } catch (error) {
    console.error('❌ Twilio initialization failed:', error.message);
  }
} else {
  console.log('⚠️  Twilio credentials not found. SMS notifications will be disabled.');
  if (!accountSid) console.log('   Missing: TWILIO_ACCOUNT_SID');
  if (!authToken) console.log('   Missing: TWILIO_AUTH_TOKEN');
  if (!twilioPhoneNumber) console.log('   Missing: TWILIO_PHONE_NUMBER');
}

/**
 * Send booking confirmation SMS to user
 * @param {Object} bookingDetails - Complete booking information
 * @returns {Promise<Object>} SMS delivery status
 */
async function sendBookingConfirmationSMS(bookingDetails) {
  // If Twilio is not configured, skip SMS
  if (!twilioClient) {
    console.log('SMS not sent - Twilio not configured');
    return { success: false, message: 'SMS service not configured' };
  }

  const {
    userPhone,
    userName,
    locationName,
    locationAddress,
    slotNumber,
    floor,
    startTime,
    endTime,
    totalAmount,
    bookingReference
  } = bookingDetails;

  // Validate phone number
  if (!userPhone) {
    console.error('User phone number not provided');
    return { success: false, message: 'Phone number not available' };
  }

  // Format phone number (ensure it starts with country code)
  let formattedPhone = userPhone.trim();
  if (!formattedPhone.startsWith('+')) {
    // Assuming India (+91), adjust based on your country
    formattedPhone = `+91${formattedPhone}`;
  }

  // Format dates - shorter format
  const formatDate = (dateString) => {
    const date = new Date(dateString);
    return date.toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  };

  // Create SMS message - SHORT version for trial accounts (under 320 chars for 2 segments)
  const message = `SmartParking: Booking Confirmed
Slot: ${slotNumber}${floor ? ` (F${floor})` : ''}
Location: ${locationName}
Start: ${formatDate(startTime)}
End: ${formatDate(endTime)}
Amount: Rs.${totalAmount}
Ref: ${bookingReference}`.trim();

  try {
    const response = await twilioClient.messages.create({
      body: message,
      from: twilioPhoneNumber,
      to: formattedPhone
    });

    console.log(`✅ SMS sent successfully to ${formattedPhone} - SID: ${response.sid}`);
    
    return {
      success: true,
      message: 'SMS sent successfully',
      sid: response.sid,
      phone: formattedPhone
    };
  } catch (error) {
    console.error('❌ Failed to send SMS:', error.message);
    
    return {
      success: false,
      message: error.message,
      error: error
    };
  }
}

/**
 * Send payment reminder SMS
 * @param {Object} details - Payment reminder details
 */
async function sendPaymentReminderSMS(details) {
  if (!twilioClient) {
    return { success: false, message: 'SMS service not configured' };
  }

  const { userPhone, userName, bookingReference, amount, dueDate } = details;

  let formattedPhone = userPhone.trim();
  if (!formattedPhone.startsWith('+')) {
    formattedPhone = `+91${formattedPhone}`;
  }

  const message = `SmartParking: Payment Due
Booking: ${bookingReference}
Amount: Rs.${amount}
Due: ${dueDate}
Pay via My Bookings section.`.trim();

  try {
    const response = await twilioClient.messages.create({
      body: message,
      from: twilioPhoneNumber,
      to: formattedPhone
    });

    console.log(`✅ Payment reminder SMS sent to ${formattedPhone}`);
    return { success: true, sid: response.sid };
  } catch (error) {
    console.error('❌ Failed to send payment reminder:', error.message);
    return { success: false, message: error.message };
  }
}

/**
 * Send parking expiration reminder SMS
 * @param {Object} details - Parking expiration details
 */
async function sendParkingExpirationSMS(details) {
  if (!twilioClient) {
    return { success: false, message: 'SMS service not configured' };
  }

  const { userPhone, userName, locationName, slotNumber, endTime } = details;

  let formattedPhone = userPhone.trim();
  if (!formattedPhone.startsWith('+')) {
    formattedPhone = `+91${formattedPhone}`;
  }

  // Format end time
  const formatDate = (dateString) => {
    const date = new Date(dateString);
    return date.toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  };

  const message = `SmartParking: Parking Ending Soon
Your parking at ${locationName} (Slot ${slotNumber}) ends at ${formatDate(endTime)}.
Please move your vehicle to avoid overtime charges.`.trim();

  try {
    const response = await twilioClient.messages.create({
      body: message,
      from: twilioPhoneNumber,
      to: formattedPhone
    });

    console.log(`✅ Parking expiration SMS sent to ${formattedPhone}`);
    return { success: true, sid: response.sid };
  } catch (error) {
    console.error('❌ Failed to send parking expiration SMS:', error.message);
    return { success: false, message: error.message };
  }
}

/**
 * Send parking overtime notification SMS
 * @param {Object} details - Overtime notification details
 */
async function sendParkingOvertimeSMS(details) {
  if (!twilioClient) {
    return { success: false, message: 'SMS service not configured' };
  }

  const { userPhone, userName, locationName, slotNumber, endTime, overtimeHours, additionalAmount } = details;

  let formattedPhone = userPhone.trim();
  if (!formattedPhone.startsWith('+')) {
    formattedPhone = `+91${formattedPhone}`;
  }

  const message = `SmartParking: Overtime Parking
Your parking at ${locationName} (Slot ${slotNumber}) has exceeded booked time by ${overtimeHours} hours.
Additional charges: Rs.${additionalAmount}. Please exit soon to minimize charges.`.trim();

  try {
    const response = await twilioClient.messages.create({
      body: message,
      from: twilioPhoneNumber,
      to: formattedPhone
    });

    console.log(`✅ Parking overtime SMS sent to ${formattedPhone}`);
    return { success: true, sid: response.sid };
  } catch (error) {
    console.error('❌ Failed to send parking overtime SMS:', error.message);
    return { success: false, message: error.message };
  }
}

module.exports = {
  sendBookingConfirmationSMS,
  sendPaymentReminderSMS,
  sendParkingExpirationSMS,
  sendParkingOvertimeSMS
};
