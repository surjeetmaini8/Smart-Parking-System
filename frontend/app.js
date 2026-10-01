const API_URL = `${window.location.origin}/api`;
let token = localStorage.getItem('token');
let user = JSON.parse(localStorage.getItem('user') || 'null');
let socket = null;
function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
}

let currentLocation = null;
let userParkingMap = null;
let allUserMapLocations = [];

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    if (token && user) {
        initializeApp();
    } else {
        showSection('login');
    }
    
    // Initialize theme
    const savedTheme = localStorage.getItem('userTheme') || 'light';
    if (savedTheme === 'dark') {
        document.body.classList.remove('light-mode');
        document.body.classList.add('dark-mode');
        document.querySelector('.theme-icon').textContent = '☀️';
    }
});

function initializeApp() {
    document.getElementById('sidebarToggleBtn').style.display = 'block';
    document.getElementById('userSidebar').style.display = 'block';
    document.getElementById('userProfileBtn').style.display = 'flex';
    document.getElementById('navUserName').textContent = user.name || 'User';
    showSection('dashboard');
    connectSocket();
    loadUserDashboard();
    
    // Initialize search listeners
    initSearchListeners();
    
    // Show welcome notification
    if (user && user.name) {
        setTimeout(() => {
            showNotification(`Welcome back, ${user.name}! 👋`, 'success');
        }, 500);
    }
}

// Sidebar & Theme Toggle
function toggleSidebar() {
    const sidebar = document.getElementById('userSidebar');
    const mainContent = document.getElementById('mainContent');
    sidebar.classList.toggle('hidden');
    mainContent.classList.toggle('expanded');
}

function toggleTheme() {
    document.body.classList.toggle('dark-mode');
    document.body.classList.toggle('light-mode');
    const isDark = document.body.classList.contains('dark-mode');
    localStorage.setItem('userTheme', isDark ? 'dark' : 'light');
    document.querySelector('.theme-icon').textContent = isDark ? '☀️' : '🌙';
}

function connectSocket() {
    socket = io(window.location.origin);
    
    socket.on('connect', () => {
        console.log('Connected to server');
    });

    socket.on('slot-update', (data) => {
        showNotification('Parking availability updated', 'info');
        loadParkingLocations();
    });

    socket.on('vehicle-entry', (data) => {
        showNotification(`Vehicle ${data.licensePlate} entered`, 'success');
    });

    socket.on('vehicle-exit', (data) => {
        showNotification(`Vehicle ${data.licensePlate} exited`, 'success');
        
        // Check if there are additional charges
        if (data.additionalCharges && data.additionalCharges > 0) {
            showNotification(`Additional charges of ₹${data.additionalCharges.toFixed(2)} for overtime parking. Please complete payment.`, 'warning');
            // Process additional payment
            if (data.bookingId) {
                processOvertimePayment(data.bookingId, data.additionalCharges);
            }
        }
    });
}

function showSection(section) {
    document.querySelectorAll('.section').forEach(s => s.style.display = 'none');
    document.querySelectorAll('.sidebar-link').forEach(link => link.classList.remove('active'));
    
    const sectionMap = {
        'login': 'loginSection',
        'register': 'registerSection',
        'forgot-password': 'forgotPasswordSection',
        'dashboard': 'dashboardSection',
        'parking': 'parkingSection',
        'map': 'mapSection',
        'bookings': 'bookingsSection',
        'vehicles': 'vehiclesSection',
        'profile': 'profileSection'
    };

    document.getElementById(sectionMap[section]).style.display = 'block';

    if (token) {
        if (section === 'dashboard') loadUserDashboard();
        if (section === 'parking') showParkingSection();
        if (section === 'map') initializeUserMap();
        if (section === 'bookings') loadMyBookings();
        if (section === 'vehicles') loadVehicles();
        if (section === 'profile') loadProfile();
    }
}

// Authentication
async function login(event) {
    event.preventDefault();
    
    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;

    try {
        const response = await fetch(`${API_URL}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });

        const data = await response.json();

        if (response.ok) {
            token = data.token;
            user = data.user;
            localStorage.setItem('token', token);
            localStorage.setItem('user', JSON.stringify(user));
            showNotification('Login successful!', 'success');
            initializeApp();
        } else {
            showNotification(data.error || 'Login failed', 'error');
        }
    } catch (error) {
        showNotification('Network error', 'error');
    }
}

async function register(event) {
    event.preventDefault();
    
    const name = document.getElementById('regName').value;
    const email = document.getElementById('regEmail').value;
    const phone = document.getElementById('regPhone').value;
    const password = document.getElementById('regPassword').value;

    try {
        const response = await fetch(`${API_URL}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email, phone, password })
        });

        const data = await response.json();

        if (response.ok) {
            token = data.token;
            user = data.user;
            localStorage.setItem('token', token);
            localStorage.setItem('user', JSON.stringify(user));
            showNotification('Registration successful!', 'success');
            initializeApp();
        } else {
            showNotification(data.error || 'Registration failed', 'error');
        }
    } catch (error) {
        showNotification('Network error', 'error');
    }
}

function logout() {
    token = null;
    user = null;
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    if (socket) socket.disconnect();
    document.getElementById('sidebarToggleBtn').style.display = 'none';
    document.getElementById('userSidebar').style.display = 'none';
    document.getElementById('userProfileBtn').style.display = 'none';
    showSection('login');
    showNotification('Logged out successfully', 'info');
}

// Parking Locations
async function loadParkingLocations(searchTerm = '') {
    try {
        let url = `${API_URL}/parking/locations`;
        if (searchTerm) {
            url += `?search=${encodeURIComponent(searchTerm)}`;
        }
        
        console.log('Fetching parking locations from:', url);
        
        const response = await fetch(url);
        console.log('Response status:', response.status);
        
        const locations = await response.json();
        console.log('Received locations:', locations);

        const parkingList = document.getElementById('parkingList');
        parkingList.innerHTML = '';

        if (locations.length === 0) {
            parkingList.innerHTML = `
                <div style="text-align: center; padding: 2rem; color: #666;">
                    <h3>🔍 No locations found</h3>
                    <p>Try a different search term or browse all locations</p>
                    <button onclick="loadParkingLocations()" class="btn-primary" style="margin-top: 1rem;">Show All Locations</button>
                </div>
            `;
            return;
        }

        locations.forEach(location => {
            const availabilityPercent = (location.available_slots / location.total_slots) * 100;
            const statusText = location.available_slots === 0 ? 'Full' : 
                              availabilityPercent < 20 ? 'Almost Full' : 
                              availabilityPercent < 50 ? 'Limited' : 'Available';
            const statusColor = location.available_slots === 0 ? '#e74c3c' : 
                               availabilityPercent < 20 ? '#f39c12' : 
                               availabilityPercent < 50 ? '#3498db' : '#2ecc71';

            const card = document.createElement('div');
            card.className = 'parking-card';
            card.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 1rem;">
                    <h3>🏛️ ${escapeHTML(location.name)}</h3>
                    <span style="background: ${statusColor}; color: white; padding: 4px 12px; border-radius: 20px; font-size: 0.85rem; font-weight: 600;">${statusText}</span>
                </div>
                <p>📍 ${escapeHTML(location.address)}</p>
                <p>🅿️ Available: <strong>${location.available_slots}/${location.total_slots}</strong> slots</p>
                <p>💵 Hourly: <strong>₹${location.hourly_rate}</strong> | Daily: <strong>₹${location.daily_rate || 'N/A'}</strong></p>
                <div class="occupancy-bar" style="margin: 15px 0;">
                    <div class="occupancy-fill" style="width: ${100 - location.occupancy_percentage}%; background: ${statusColor};"></div>
                </div>
                <button onclick="openBookingModal(${location.location_id})" class="btn-primary" style="width: 100%; margin-top: 10px;"
                    ${location.available_slots === 0 ? 'disabled' : ''}>
                    ${location.available_slots === 0 ? '🚫 Full' : '📝 Book Now'}
                </button>
            `;
            parkingList.appendChild(card);
        });
    } catch (error) {
        console.error('Failed to load parking locations:', error);
        showNotification('Failed to load parking locations', 'error');
    }
}

// Search parking locations
function searchParkingLocations() {
    const searchTerm = document.getElementById('searchLocation').value.trim();
    console.log('Searching for:', searchTerm);
    // Always call loadParkingLocations, even with empty search term
    loadParkingLocations(searchTerm);
}

// Allow Enter key to trigger search
function initSearchListeners() {
    const searchInput = document.getElementById('searchLocation');
    if (searchInput) {
        searchInput.addEventListener('keypress', function(event) {
            console.log('Key pressed:', event.key);
            if (event.key === 'Enter') {
                console.log('Enter key pressed, triggering search');
                searchParkingLocations();
            }
        });
    }
}

async function openBookingModal(locationId) {
    currentLocation = locationId;
    
    try {
        const [locationRes, vehiclesRes, profileRes] = await Promise.all([
            fetch(`${API_URL}/parking/locations/${locationId}`),
            fetch(`${API_URL}/vehicles`, {
                headers: { 'Authorization': `Bearer ${token}` }
            }),
            fetch(`${API_URL}/auth/me`, {
                headers: { 'Authorization': `Bearer ${token}` }
            })
        ]);

        const location = await locationRes.json();
        currentLocationData = location;
        const vehicles = await vehiclesRes.json();
        const profile = await profileRes.json();

        if (vehicles.length === 0) {
            showNotification('Please add a vehicle first', 'error');
            showSection('vehicles');
            return;
        }

        document.getElementById('bookLocationName').textContent = location.name;
        
        const vehicleSelect = document.getElementById('bookVehicle');
        vehicleSelect.innerHTML = vehicles.map(v => 
            `<option value="${v.vehicle_id}">${v.license_plate} - ${v.make} ${v.model}</option>`
        ).join('');

        // Load available slots
        const slotsRes = await fetch(`${API_URL}/parking/locations/${locationId}/slots?status=available`);
        const slots = await slotsRes.json();

        const slotSelect = document.getElementById('bookSlot');
        slotSelect.innerHTML = slots.map(s => 
            `<option value="${s.slot_id}">${s.slot_number} (${s.slot_type})</option>`
        ).join('');

        // Set min and max date/time constraints
        const now = new Date();
        const minDateTime = new Date(now.getTime() + 5 * 60000); // 5 minutes from now
        const maxDateTime = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days from now
        
        const startInput = document.getElementById('bookStartTime');
        const endInput = document.getElementById('bookEndTime');
        
        // Set min and max attributes
        startInput.min = minDateTime.toISOString().slice(0, 16);
        startInput.max = maxDateTime.toISOString().slice(0, 16);
        endInput.min = minDateTime.toISOString().slice(0, 16);
        endInput.max = maxDateTime.toISOString().slice(0, 16);
        
        // Set default times
        minDateTime.setMinutes(minDateTime.getMinutes() - minDateTime.getTimezoneOffset());
        startInput.value = minDateTime.toISOString().slice(0, 16);
        
        const later = new Date(minDateTime.getTime() + 2 * 60 * 60 * 1000);
        endInput.value = later.toISOString().slice(0, 16);

        // Update payment method with wallet balance
        const paymentSelect = document.getElementById('paymentMethod');
        const walletBalance = parseFloat(profile.wallet_balance || 0);
        paymentSelect.innerHTML = `
            <option value="">Select Payment Method</option>
            <option value="wallet">💰 Wallet (Balance: ₹${walletBalance.toFixed(2)})</option>
            <option value="razorpay">💳 Card/UPI/NetBanking (Razorpay)</option>
            <option value="cash">💵 Cash on Arrival</option>
        `;

        document.getElementById('bookingModal').style.display = 'block';
        calculateCost(location.hourly_rate, location.daily_rate);
    } catch (error) {
        showNotification('Failed to open booking form', 'error');
    }
}

function closeBookingModal() {
    document.getElementById('bookingModal').style.display = 'none';
}

function calculateCost(hourlyRate, dailyRate) {
    const start = new Date(document.getElementById('bookStartTime').value);
    const end = new Date(document.getElementById('bookEndTime').value);
    
    if (start && end && end > start) {
        const hours = Math.ceil((end - start) / (1000 * 60 * 60));
        const cost = hours > 24 ? dailyRate : hourlyRate * hours;
        
        document.getElementById('estimatedCost').textContent = `₹${cost.toFixed(2)}`;
    } else {
        document.getElementById('estimatedCost').textContent = '₹0.00';
    }
}

async function createBooking() {
    const vehicleId = document.getElementById('bookVehicle').value;
    const slotId = document.getElementById('bookSlot').value;
    const startTime = document.getElementById('bookStartTime').value;
    const endTime = document.getElementById('bookEndTime').value;
    const paymentMethod = document.getElementById('paymentMethod').value;

    if (!paymentMethod) {
        showNotification('Please select a payment method', 'error');
        return;
    }

    // Validate dates
    const now = new Date();
    const start = new Date(startTime);
    const end = new Date(endTime);
    const oneWeekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    if (start < now) {
        showNotification('Start time cannot be in the past', 'error');
        return;
    }

    if (end <= start) {
        showNotification('End time must be after start time', 'error');
        return;
    }

    if (start > oneWeekFromNow) {
        showNotification('Bookings can only be made up to 7 days in advance', 'error');
        return;
    }

    if (end > oneWeekFromNow) {
        showNotification('Booking end time cannot exceed 7 days from now', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/bookings`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                locationId: currentLocation,
                slotId: parseInt(slotId),
                vehicleId: parseInt(vehicleId),
                startTime,
                endTime,
                paymentMethod
            })
        });

        const data = await response.json();

        if (response.ok) {
            // Process payment if not cash
            if (paymentMethod !== 'cash') {
                const paymentSuccess = await processPayment(data.booking_id, data.total_amount, paymentMethod);
                
                if (!paymentSuccess) {
                    // Payment failed - cancel the pending booking
                    await cancelPendingBooking(data.booking_id);
                    showNotification('Booking cancelled due to payment failure. Please try again.', 'error');
                    closeBookingModal();
                    loadParkingLocations();
                    return;
                }
                showNotification('Booking confirmed and payment successful!', 'success');
            } else {
                showNotification('Booking confirmed! Please pay cash on arrival.', 'success');
            }
            
            closeBookingModal();
            loadParkingLocations();
            showSection('bookings');
        } else {
            showNotification(data.error || 'Booking failed', 'error');
        }
    } catch (error) {
        showNotification('Network error', 'error');
    }
}

async function processPayment(bookingId, amount, paymentMethod) {
    try {
        // For Razorpay, open payment gateway
        if (paymentMethod === 'razorpay') {
            return await processRazorpayPayment(bookingId, amount);
        }

        // For wallet and other methods, use existing flow
        const response = await fetch(`${API_URL}/payments`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                bookingId,
                amount,
                paymentMethod
            })
        });

        const data = await response.json();

        if (response.ok) {
            showNotification(data.message || `Payment of ₹${amount} processed successfully!`, 'success');
            return true;
        } else {
            if (data.error === 'Insufficient wallet balance') {
                showNotification(
                    `Insufficient wallet balance! You have ₹${data.currentBalance.toFixed(2)}, but need ₹${data.requiredAmount.toFixed(2)}. Please add ₹${data.shortfall.toFixed(2)} to your wallet or choose another payment method.`,
                    'error'
                );
            } else {
                showNotification(data.error || 'Payment processing failed. Please try again.', 'error');
            }
            return false;
        }
    } catch (error) {
        showNotification('Payment network error', 'error');
        return false;
    }
}

async function processRazorpayPayment(bookingId, amount) {
    try {
        // Create Razorpay order
        const orderResponse = await fetch(`${API_URL}/payments/create-order`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ bookingId, amount })
        });

        const orderData = await orderResponse.json();

        if (!orderResponse.ok) {
            showNotification(orderData.error || 'Failed to create payment order', 'error');
            return false;
        }

        // Open Razorpay payment modal
        return new Promise((resolve) => {
            const options = {
                key: orderData.keyId,
                amount: orderData.amount,
                currency: orderData.currency,
                name: 'Smart Parking System',
                description: `Booking Payment - ₹${amount}`,
                order_id: orderData.orderId,
                handler: async function (response) {
                    // Verify payment on backend
                    const verifyResponse = await fetch(`${API_URL}/payments/verify-payment`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                        },
                        body: JSON.stringify({
                            razorpay_order_id: response.razorpay_order_id,
                            razorpay_payment_id: response.razorpay_payment_id,
                            razorpay_signature: response.razorpay_signature,
                            bookingId,
                            amount
                        })
                    });

                    const verifyData = await verifyResponse.json();

                    if (verifyResponse.ok && verifyData.success) {
                        showNotification('Payment successful! ₹' + amount + ' paid via Razorpay', 'success');
                        resolve(true);
                    } else {
                        showNotification('Payment verification failed', 'error');
                        resolve(false);
                    }
                },
                prefill: {
                    name: user.name || '',
                    email: user.email || '',
                    contact: user.phone || ''
                },
                theme: {
                    color: '#667eea'
                },
                modal: {
                    ondismiss: function() {
                        showNotification('Payment cancelled', 'info');
                        resolve(false);
                    }
                }
            };

            const rzp = new Razorpay(options);
            rzp.open();
        });
    } catch (error) {
        showNotification('Razorpay payment error: ' + error.message, 'error');
        return false;
    }
}

// Bookings
async function loadMyBookings() {
    const filter = document.getElementById('bookingFilter').value;
    
    try {
        const url = filter ? 
            `${API_URL}/bookings/my-bookings?status=${filter}` : 
            `${API_URL}/bookings/my-bookings`;

        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const bookings = await response.json();
        const bookingsList = document.getElementById('bookingsList');
        bookingsList.innerHTML = '';

        if (bookings.length === 0) {
            bookingsList.innerHTML = '<p>No bookings found</p>';
            return;
        }

        bookings.forEach(booking => {
            const card = document.createElement('div');
            card.className = 'booking-card';
            card.innerHTML = `
                <h3>${escapeHTML(booking.location_name)}</h3>
                <p>Reference: <strong>${escapeHTML(booking.booking_reference)}</strong></p>
                <p>Slot: ${escapeHTML(booking.slot_number)} (${escapeHTML(booking.floor || 'N/A')})</p>
                <p>Vehicle: ${escapeHTML(booking.license_plate)}</p>
                <p>Start: ${new Date(booking.start_time).toLocaleString()}</p>
                <p>End: ${new Date(booking.end_time).toLocaleString()}</p>
                <p>Amount: ₹${booking.total_amount}</p>
                <span class="status-badge status-${escapeHTML(booking.status)}">${escapeHTML(booking.status)}</span>
                ${booking.status === 'confirmed' ? 
                    `<button onclick="cancelBooking(${booking.booking_id})" class="btn-danger">Cancel</button>` : 
                    ''}
            `;
            bookingsList.appendChild(card);
        });
    } catch (error) {
        showNotification('Failed to load bookings', 'error');
    }
}

async function cancelBooking(bookingId) {
    if (!confirm('Are you sure you want to cancel this booking?')) return;

    try {
        const response = await fetch(`${API_URL}/bookings/${bookingId}/cancel`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (response.ok) {
            showNotification('Booking cancelled', 'success');
            loadMyBookings();
        } else {
            const data = await response.json();
            showNotification(data.error || 'Cancellation failed', 'error');
        }
    } catch (error) {
        showNotification('Network error', 'error');
    }
}

async function cancelPendingBooking(bookingId) {
    // Auto-cancel pending booking without confirmation (for payment failures)
    try {
        await fetch(`${API_URL}/bookings/${bookingId}/cancel`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}` }
        });
    } catch (error) {
        console.error('Failed to cancel pending booking:', error);
    }
}

// Vehicles
async function loadVehicles() {
    try {
        const response = await fetch(`${API_URL}/vehicles`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const vehicles = await response.json();
        const vehiclesList = document.getElementById('vehiclesList');
        vehiclesList.innerHTML = '';

        if (vehicles.length === 0) {
            vehiclesList.innerHTML = '<p>No vehicles registered</p>';
            return;
        }

        vehicles.forEach(vehicle => {
            const card = document.createElement('div');
            card.className = 'vehicle-card';
            card.innerHTML = `
                <h3>${escapeHTML(vehicle.license_plate)}</h3>
                <p>${escapeHTML(vehicle.make)} ${escapeHTML(vehicle.model)}</p>
                <p>Color: ${escapeHTML(vehicle.color)}</p>
                <p>Type: ${escapeHTML(vehicle.vehicle_type)}</p>
                ${vehicle.is_primary ? '<span class="badge">Primary</span>' : ''}
                <button onclick="deleteVehicle(${vehicle.vehicle_id})" class="btn-danger">Delete</button>
            `;
            vehiclesList.appendChild(card);
        });
    } catch (error) {
        showNotification('Failed to load vehicles', 'error');
    }
}

function showAddVehicleForm() {
    document.getElementById('addVehicleForm').style.display = 'block';
}

function hideAddVehicleForm() {
    document.getElementById('addVehicleForm').style.display = 'none';
}

async function addVehicle(event) {
    event.preventDefault();

    const vehicleData = {
        licensePlate: document.getElementById('vehiclePlate').value,
        make: document.getElementById('vehicleMake').value,
        model: document.getElementById('vehicleModel').value,
        color: document.getElementById('vehicleColor').value,
        vehicleType: document.getElementById('vehicleType').value,
        isPrimary: document.getElementById('vehiclePrimary').checked
    };

    try {
        const response = await fetch(`${API_URL}/vehicles`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(vehicleData)
        });

        if (response.ok) {
            showNotification('Vehicle added successfully', 'success');
            hideAddVehicleForm();
            loadVehicles();
            event.target.reset();
        } else {
            const data = await response.json();
            showNotification(data.error || 'Failed to add vehicle', 'error');
        }
    } catch (error) {
        showNotification('Network error', 'error');
    }
}

async function deleteVehicle(vehicleId) {
    if (!confirm('Are you sure you want to delete this vehicle?')) return;

    try {
        const response = await fetch(`${API_URL}/vehicles/${vehicleId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (response.ok) {
            showNotification('Vehicle deleted', 'success');
            loadVehicles();
        } else {
            showNotification('Failed to delete vehicle', 'error');
        }
    } catch (error) {
        showNotification('Network error', 'error');
    }
}

// Profile
async function loadProfile() {
    try {
        const response = await fetch(`${API_URL}/auth/me`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const userData = await response.json();
        const profileInfo = document.getElementById('profileInfo');
        profileInfo.innerHTML = `
            <div class="profile-card">
                <h3>${escapeHTML(userData.name)}</h3>
                <p>Email: ${escapeHTML(userData.email)}</p>
                <p>Phone: ${escapeHTML(userData.phone)}</p>
                <p>Wallet Balance: ₹${parseFloat(userData.wallet_balance).toFixed(2)}</p>
                <p>Member since: ${new Date(userData.created_at).toLocaleDateString()}</p>
            </div>
        `;
        
        // Update wallet balance display
        const walletBalanceEl = document.getElementById('walletBalance');
        if (walletBalanceEl) {
            walletBalanceEl.textContent = `₹${parseFloat(userData.wallet_balance).toFixed(2)}`;
        }
    } catch (error) {
        showNotification('Failed to load profile', 'error');
    }
}

async function addFundsToWallet() {
    const amount = parseFloat(document.getElementById('addFundsAmount').value);
    
    if (!amount || amount <= 0) {
        showNotification('Please enter a valid amount', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/payments/wallet/add`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ amount })
        });

        const data = await response.json();

        if (response.ok) {
            showNotification(`₹${amount} added to wallet successfully!`, 'success');
            document.getElementById('addFundsAmount').value = '';
            loadProfile();
        } else {
            showNotification(data.error || 'Failed to add funds', 'error');
        }
    } catch (error) {
        showNotification('Network error', 'error');
    }
}

// Utility
function showNotification(message, type = 'info') {
    const notification = document.getElementById('notification');
    notification.textContent = message;
    notification.className = `notification ${type} show`;
    
    setTimeout(() => {
        notification.classList.remove('show');
    }, 3000);
}

function showForgotPassword(event) {
    event.preventDefault();
    showSection('forgot-password');
}

async function resetPassword(event) {
    event.preventDefault();
    
    const email = document.getElementById('resetEmail').value;

    try {
        const response = await fetch(`${API_URL}/auth/forgot-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });

        const data = await response.json();

        if (response.ok) {
            showNotification('Password reset instructions sent to your email!', 'success');
            setTimeout(() => showSection('login'), 2000);
        } else {
            showNotification(data.error || 'Failed to send reset email', 'error');
        }
    } catch (error) {
        showNotification('Network error', 'error');
    }
}

// Event listeners
document.addEventListener('DOMContentLoaded', () => {
    const startTimeInput = document.getElementById('bookStartTime');
    const endTimeInput = document.getElementById('bookEndTime');
    
    if (startTimeInput) {
        startTimeInput.addEventListener('change', () => {
            if (currentLocation) {
                updateBookingCost();
            }
        });
    }
    
    if (endTimeInput) {
        endTimeInput.addEventListener('change', () => {
            if (currentLocation) {
                updateBookingCost();
            }
        });
    }
});

let currentLocationData = null;

async function updateBookingCost() {
    if (currentLocationData) {
        calculateCost(currentLocationData.hourly_rate, currentLocationData.daily_rate);
    }
}

// User Dashboard
async function loadUserDashboard() {
    try {
        // Update user name
        document.getElementById('userName').textContent = user.name || 'User';
        
        // Load dashboard stats
        const statsResponse = await fetch(`${API_URL}/auth/dashboard-stats`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        if (statsResponse.ok) {
            const stats = await statsResponse.json();
            
            // Update stat cards
            document.getElementById('userActiveBookings').textContent = stats.active_bookings || 0;
            document.getElementById('userTotalVehicles').textContent = stats.total_vehicles || 0;
            document.getElementById('userWalletBalance').textContent = `₹${parseFloat(stats.wallet_balance || 0).toFixed(2)}`;
            document.getElementById('userCompletedBookings').textContent = stats.completed_bookings || 0;
            
            // Update spending summary
            document.getElementById('thisMonthSpending').textContent = `₹${parseFloat(stats.month_spending || 0).toFixed(2)}`;
            document.getElementById('thisMonthBookings').textContent = `${stats.month_bookings || 0} bookings`;
            document.getElementById('totalSpending').textContent = `₹${parseFloat(stats.total_spending || 0).toFixed(2)}`;
            document.getElementById('totalBookingsCount').textContent = `${stats.total_bookings || 0} bookings`;
            
            const avgSpending = stats.total_bookings > 0 ? stats.total_spending / stats.total_bookings : 0;
            document.getElementById('avgSpending').textContent = `₹${avgSpending.toFixed(2)}`;
        }
        
        // Load recent bookings
        const bookingsResponse = await fetch(`${API_URL}/bookings/my-bookings?limit=3`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        if (bookingsResponse.ok) {
            const bookings = await bookingsResponse.json();
            const recentBookings = document.getElementById('recentBookings');
            
            if (bookings.length === 0) {
                recentBookings.innerHTML = '<p style="text-align: center; color: #666; padding: 2rem;">No recent bookings</p>';
            } else {
                recentBookings.innerHTML = '';
                bookings.forEach(booking => {
                    const bookingItem = document.createElement('div');
                    bookingItem.className = 'recent-booking-item';
                    bookingItem.innerHTML = `
                        <div class="booking-info">
                            <h4>${escapeHTML(booking.location_name)}</h4>
                            <p>${new Date(booking.start_time).toLocaleDateString()} | Slot ${booking.slot_number || 'N/A'}</p>
                        </div>
                        <span class="booking-status ${escapeHTML(booking.status)}">${escapeHTML(booking.status)}</span>
                    `;
                    recentBookings.appendChild(bookingItem);
                });
            }
        }
    } catch (error) {
        console.error('Failed to load dashboard:', error);
        showNotification('Failed to load dashboard data', 'error');
    }
}

// User Map Initialization
function initializeUserMap() {
    if (userParkingMap) {
        userParkingMap.invalidateSize();
        return;
    }
    
    setTimeout(() => {
        const mapElement = document.getElementById('userParkingMap');
        if (!mapElement) return;
        
        userParkingMap = L.map('userParkingMap').setView([28.6139, 77.2090], 12);
        
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors'
        }).addTo(userParkingMap);
        
        // Load locations and add markers
        loadUserMapLocations();
    }, 100);
}

async function loadUserMapLocations() {
    try {
        const response = await fetch(`${API_URL}/parking/locations`, {
            headers: token ? { 'Authorization': `Bearer ${token}` } : {}
        });
        allUserMapLocations = await response.json();
        
        allUserMapLocations.forEach(loc => {
            const availabilityPercent = (loc.available_slots / loc.total_slots) * 100;
            const markerColor = loc.available_slots === 0 ? 'red' : 
                               availabilityPercent < 20 ? 'orange' : 
                               availabilityPercent < 50 ? 'blue' : 'green';
            
            const markerIcon = L.divIcon({
                className: 'custom-marker',
                html: `<div style="background: ${markerColor}; width: 30px; height: 30px; border-radius: 50%; border: 3px solid white; box-shadow: 0 2px 5px rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; font-size: 16px;">🅿️</div>`,
                iconSize: [30, 30]
            });
            
            const marker = L.marker([loc.latitude, loc.longitude], { icon: markerIcon }).addTo(userParkingMap);
            marker.bindPopup(`
                <div style="padding: 10px; min-width: 200px;">
                    <h4 style="margin: 0 0 10px 0; color: #667eea;">${loc.name}</h4>
                    <p style="margin: 5px 0; font-size: 0.9em;"><strong>📍</strong> ${loc.address}</p>
                    <p style="margin: 5px 0; font-size: 0.9em;"><strong>🅿️</strong> Available: ${loc.available_slots}/${loc.total_slots}</p>
                    <p style="margin: 5px 0; font-size: 0.9em;"><strong>💵</strong> Rate: ₹${loc.hourly_rate}/hr</p>
                    <button onclick="openBookingModal(${loc.location_id})" style="margin-top: 10px; padding: 8px 16px; background: #667eea; color: white; border: none; border-radius: 6px; cursor: pointer; width: 100%;" ${loc.available_slots === 0 ? 'disabled' : ''}>
                        ${loc.available_slots === 0 ? '🚫 Full' : '📝 Book Now'}
                    </button>
                </div>
            `);
        });
        
        // Fit map to show all markers
        if (allUserMapLocations.length > 0) {
            const bounds = L.latLngBounds(allUserMapLocations.map(loc => [loc.latitude, loc.longitude]));
            userParkingMap.fitBounds(bounds, { padding: [50, 50] });
        }
    } catch (error) {
        console.error('Failed to load map locations:', error);
        showNotification('Failed to load map locations', 'error');
    }
}

function filterUserMapLocations() {
    const searchTerm = document.getElementById('userMapSearch').value.toLowerCase();
    const slotFilter = document.getElementById('userMapSlotFilter').value;
    const priceFilter = document.getElementById('userMapPriceFilter').value;
    
    if (!userParkingMap) return;
    
    // Clear existing markers
    userParkingMap.eachLayer(layer => {
        if (layer instanceof L.Marker) {
            userParkingMap.removeLayer(layer);
        }
    });
    
    // Filter locations
    let filtered = allUserMapLocations;
    
    if (searchTerm) {
        filtered = filtered.filter(loc => 
            loc.name.toLowerCase().includes(searchTerm) ||
            loc.address.toLowerCase().includes(searchTerm)
        );
    }
    
    if (slotFilter === 'available') {
        filtered = filtered.filter(loc => loc.available_slots > loc.total_slots * 0.5);
    } else if (slotFilter === 'limited') {
        filtered = filtered.filter(loc => loc.available_slots > 0 && loc.available_slots <= loc.total_slots * 0.5);
    } else if (slotFilter === 'full') {
        filtered = filtered.filter(loc => loc.available_slots === 0);
    }
    
    if (priceFilter === 'low') {
        filtered = filtered.filter(loc => loc.hourly_rate <= 50);
    } else if (priceFilter === 'medium') {
        filtered = filtered.filter(loc => loc.hourly_rate > 50 && loc.hourly_rate <= 100);
    } else if (priceFilter === 'high') {
        filtered = filtered.filter(loc => loc.hourly_rate > 100);
    }
    
    // Add filtered markers
    filtered.forEach(loc => {
        const availabilityPercent = (loc.available_slots / loc.total_slots) * 100;
        const markerColor = loc.available_slots === 0 ? 'red' : 
                           availabilityPercent < 20 ? 'orange' : 
                           availabilityPercent < 50 ? 'blue' : 'green';
        
        const markerIcon = L.divIcon({
            className: 'custom-marker',
            html: `<div style="background: ${markerColor}; width: 30px; height: 30px; border-radius: 50%; border: 3px solid white; box-shadow: 0 2px 5px rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; font-size: 16px;">🅿️</div>`,
            iconSize: [30, 30]
        });
        
        const marker = L.marker([loc.latitude, loc.longitude], { icon: markerIcon }).addTo(userParkingMap);
        marker.bindPopup(`
            <div style="padding: 10px; min-width: 200px;">
                <h4 style="margin: 0 0 10px 0; color: #667eea;">${loc.name}</h4>
                <p style="margin: 5px 0; font-size: 0.9em;"><strong>📍</strong> ${loc.address}</p>
                <p style="margin: 5px 0; font-size: 0.9em;"><strong>🅿️</strong> Available: ${loc.available_slots}/${loc.total_slots}</p>
                <p style="margin: 5px 0; font-size: 0.9em;"><strong>💵</strong> Rate: ₹${loc.hourly_rate}/hr</p>
                <button onclick="openBookingModal(${loc.location_id})" style="margin-top: 10px; padding: 8px 16px; background: #667eea; color: white; border: none; border-radius: 6px; cursor: pointer; width: 100%;" ${loc.available_slots === 0 ? 'disabled' : ''}>
                    ${loc.available_slots === 0 ? '🚫 Full' : '📝 Book Now'}
                </button>
            </div>
        `);
    });
    
    // Fit map to filtered markers
    if (filtered.length > 0) {
        const bounds = L.latLngBounds(filtered.map(loc => [loc.latitude, loc.longitude]));
        userParkingMap.fitBounds(bounds, { padding: [50, 50] });
    }
}

// Show parking section while preserving search state
function showParkingSection() {
    // Get the current search term from the input field
    const searchTerm = document.getElementById('searchLocation')?.value.trim() || '';
    loadParkingLocations(searchTerm);
}

// Process additional payment for overtime parking
async function processOvertimePayment(bookingId, additionalAmount) {
    // Create modal for payment selection
    const modal = document.createElement('div');
    modal.id = 'overtimePaymentModal';
    modal.className = 'modal';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 500px;">
            <span class="close" onclick="closeOvertimePaymentModal()">&times;</span>
            <h2>Additional Payment Required</h2>
            <p>You have exceeded your booked parking time.</p>
            <p><strong>Additional Charges: ₹${additionalAmount.toFixed(2)}</strong></p>
            <div style="margin: 20px 0;">
                <label>Select Payment Method:</label>
                <select id="overtimePaymentMethod" style="width: 100%; padding: 10px; margin-top: 10px;">
                    <option value="wallet">Wallet</option>
                    <option value="cash">Cash at Exit</option>
                </select>
            </div>
            <div style="display: flex; gap: 10px; justify-content: flex-end;">
                <button onclick="closeOvertimePaymentModal()" class="btn-secondary">Cancel</button>
                <button onclick="submitOvertimePayment(${bookingId})" class="btn-primary">Pay Now</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.style.display = 'block';
}

function closeOvertimePaymentModal() {
    const modal = document.getElementById('overtimePaymentModal');
    if (modal) {
        modal.remove();
    }
}

async function submitOvertimePayment(bookingId) {
    const paymentMethod = document.getElementById('overtimePaymentMethod').value;
    
    try {
        const response = await fetch(`${API_URL}/alpr/exit-payment`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                bookingId: bookingId,
                paymentMethod: paymentMethod
            })
        });

        const data = await response.json();

        if (response.ok) {
            showNotification('Additional payment processed successfully!', 'success');
            closeOvertimePaymentModal();
            // Refresh bookings
            if (document.getElementById('bookingsSection').style.display !== 'none') {
                loadMyBookings();
            }
        } else {
            if (data.error === 'Insufficient wallet balance') {
                showNotification(
                    `Insufficient wallet balance! You have ₹${data.currentBalance.toFixed(2)}, but need ₹${data.requiredAmount.toFixed(2)}. Please add ₹${data.shortfall.toFixed(2)} to your wallet or choose cash payment.`,
                    'error'
                );
            } else {
                showNotification(data.error || 'Failed to process additional payment', 'error');
            }
        }
    } catch (error) {
        showNotification('Network error', 'error');
    }
}
