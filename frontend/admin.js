const API_URL = `${window.location.origin}/api`;
let token = localStorage.getItem('adminToken');
let user = JSON.parse(localStorage.getItem('adminUser') || 'null');
let socket = null;
function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
}

let parkingMap = null;
let charts = {};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    if (token && user && (user.role === 'admin' || user.role === 'owner')) {
        initializeAdmin();
    } else {
        showSection('login');
    }
    
    // Initialize theme
    const savedTheme = localStorage.getItem('adminTheme') || 'light';
    if (savedTheme === 'dark') {
        document.body.classList.add('dark-mode');
        document.querySelector('.theme-icon').textContent = '☀️';
    }
});

function initializeAdmin() {
    document.getElementById('sidebar').style.display = 'block';
    document.getElementById('adminName').textContent = user.name || 'Admin';
    showSection('dashboard');
    connectSocket();
    loadDashboardStats();
    initializeCharts();
}

// Sidebar & Theme Toggle
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const mainContent = document.getElementById('mainContent');
    sidebar.classList.toggle('hidden');
    mainContent.classList.toggle('expanded');
}

function toggleTheme() {
    document.body.classList.toggle('dark-mode');
    const isDark = document.body.classList.contains('dark-mode');
    localStorage.setItem('adminTheme', isDark ? 'dark' : 'light');
    document.querySelector('.theme-icon').textContent = isDark ? '☀️' : '🌙';
    
    // Update charts if they exist
    if (Object.keys(charts).length > 0) {
        updateChartsTheme();
    }
}

function toggleNotifications() {
    const dropdown = document.getElementById('notificationDropdown');
    dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
}

function markAllRead() {
    document.getElementById('notificationCount').textContent = '0';
    showNotification('All notifications marked as read', 'info');
}

function connectSocket() {
    socket = io(window.location.origin);
    
    socket.on('connect', () => {
        console.log('Connected to server');
    });

    socket.on('slot-update', (data) => {
        addRealtimeActivity(`Slot ${data.slotId} status changed to ${data.status}`);
        loadDashboardStats();
    });

    socket.on('vehicle-entry', (data) => {
        addRealtimeActivity(`✅ Entry: ${data.licensePlate} - Slot ${data.slotNumber}`);
        loadDashboardStats();
    });

    socket.on('vehicle-exit', (data) => {
        addRealtimeActivity(`🚗 Exit: Booking ${data.bookingId} - Slot ${data.slotNumber}`);
        loadDashboardStats();
    });
}

function addRealtimeActivity(message) {
    const activityDiv = document.getElementById('realtimeActivity');
    const item = document.createElement('div');
    item.className = 'activity-item';
    item.innerHTML = `
        <span class="activity-time">${new Date().toLocaleTimeString()}</span>
        <span class="activity-msg">${message}</span>
    `;
    activityDiv.insertBefore(item, activityDiv.firstChild);
    
    // Keep only last 10 items
    while (activityDiv.children.length > 10) {
        activityDiv.removeChild(activityDiv.lastChild);
    }
}

function showSection(section) {
    document.querySelectorAll('.section').forEach(s => s.style.display = 'none');
    document.querySelectorAll('.sidebar-link').forEach(link => link.classList.remove('active'));
    
    const sectionMap = {
        'login': 'loginSection',
        'dashboard': 'dashboardSection',
        'locations': 'locationsSection',
        'slots': 'slotsSection',
        'map': 'mapSection',
        'bookings': 'bookingsSection',
        'logs': 'logsSection',
        'revenue': 'revenueSection',
        'analytics': 'analyticsSection',
        'users': 'usersSection',
        'vehicles': 'vehiclesSection',
        'settings': 'settingsSection',
        'reports': 'reportsSection'
    };

    const sectionId = sectionMap[section];
    if (sectionId) {
        document.getElementById(sectionId).style.display = 'block';
    }

    if (token) {
        if (section === 'dashboard') {
            loadDashboardStats();
            updateAllCharts();
        }
        if (section === 'locations') loadLocations();
        if (section === 'slots') loadSlots();
        if (section === 'map') initializeMap();
        if (section === 'bookings') loadBookings();
        if (section === 'logs') loadLogs();
        if (section === 'revenue') loadRevenue();
        if (section === 'analytics') loadAnalytics();
        if (section === 'users') loadUsers();
        if (section === 'vehicles') loadVehicles();
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
            if (data.user && (data.user.role === 'admin' || data.user.role === 'owner')) {
                token = data.token;
                user = data.user;
                localStorage.setItem('adminToken', token);
                localStorage.setItem('adminUser', JSON.stringify(user));
                showNotification('Login successful!', 'success');
                initializeAdmin();
            } else {
                showNotification('Access denied. Admin privileges required.', 'error');
            }
        } else {
            showNotification(data.error || 'Login failed', 'error');
        }
    } catch (error) {
        showNotification('Network error', 'error');
    }
}

function logout() {
    token = null;
    user = null;
    localStorage.removeItem('adminToken');
    localStorage.removeItem('adminUser');
    if (socket) socket.disconnect();
    document.getElementById('navMenu').style.display = 'none';
    showSection('login');
    showNotification('Logged out successfully', 'info');
}

// Dashboard
async function loadDashboardStats() {
    try {
        const response = await fetch(`${API_URL}/admin/stats`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const stats = await response.json();

        // Update new dashboard widgets
        document.getElementById('totalBookingsWidget').textContent = stats.total_bookings || 0;
        document.getElementById('monthlyBookingsBadge').textContent = `+${stats.monthly_bookings || 0} this month`;
        
        const occupied = (stats.total_slots || 0) - (stats.available_slots || 0);
        document.getElementById('activeSlotWidget').textContent = `${occupied} / ${stats.total_slots || 0}`;
        const utilization = stats.total_slots > 0 ? ((occupied / stats.total_slots) * 100).toFixed(0) : 0;
        document.getElementById('slotUtilization').textContent = `${utilization}% utilized`;
        
        document.getElementById('totalRevenueWidget').textContent = `₹${parseFloat(stats.total_revenue || 0).toFixed(0)}`;
        document.getElementById('monthlyRevenue').textContent = `₹${parseFloat(stats.monthly_revenue || 0).toFixed(0)} monthly`;
        
        document.getElementById('vehiclesInsideWidget').textContent = stats.vehicles_inside || 0;
        
        document.getElementById('newUsersWidget').textContent = stats.new_users_today || 0;
        document.getElementById('totalUsersCount').textContent = `${stats.total_users || 0} total users`;
        
        // Old stats for backward compatibility
        if (document.getElementById('activeBookings')) {
            document.getElementById('activeBookings').textContent = stats.active_bookings || 0;
        }
        if (document.getElementById('todayBookings')) {
            document.getElementById('todayBookings').textContent = stats.today_bookings || 0;
        }
        if (document.getElementById('todayRevenue')) {
            document.getElementById('todayRevenue').textContent = `₹${stats.today_revenue || 0}`;
        }
        if (document.getElementById('totalUsers')) {
            document.getElementById('totalUsers').textContent = stats.total_users || 0;
        }
        if (document.getElementById('totalSlots')) {
            document.getElementById('totalSlots').textContent = stats.total_slots || 0;
        }
        if (document.getElementById('availableSlots')) {
            document.getElementById('availableSlots').textContent = stats.available_slots || 0;
        }
    } catch (error) {
        console.error('Failed to load statistics:', error);
    }
}

// Locations
async function loadLocations() {
    try {
        const response = await fetch(`${API_URL}/admin/locations`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const locations = await response.json();
        const locationsList = document.getElementById('locationsList');
        
        if (locations.length === 0) {
            locationsList.innerHTML = '<p>No locations found</p>';
            return;
        }

        let html = `
            <table>
                <thead>
                    <tr>
                        <th>Name</th>
                        <th>Address</th>
                        <th>Total Slots</th>
                        <th>Available</th>
                        <th>Occupancy</th>
                        <th>Hourly Rate</th>
                        <th>Status</th>
                        <th>Camera</th>
                    </tr>
                </thead>
                <tbody>
        `;

        locations.forEach(loc => {
            html += `
                <tr>
                    <td>${escapeHTML(loc.name)}</td>
                    <td>${escapeHTML(loc.address)}</td>
                    <td>${loc.total_slots}</td>
                    <td>${loc.available_slots}</td>
                    <td>
                        <div class="progress-bar">
                            <div class="progress-fill" style="width: ${100 - loc.occupancy_percentage}%"></div>
                        </div>
                    </td>
                    <td>₹${loc.hourly_rate}</td>
                    <td><span class="status-badge ${loc.is_active ? 'active' : 'inactive'}">${loc.is_active ? 'Active' : 'Inactive'}</span></td>
                    <td>${loc.has_camera ? '✅' : '❌'}</td>
                </tr>
            `;
        });

        html += '</tbody></table>';
        locationsList.innerHTML = html;

        // Populate location filters
        updateLocationFilters(locations);
    } catch (error) {
        showNotification('Failed to load locations', 'error');
    }
}

function updateLocationFilters(locations) {
    const filters = [
        document.getElementById('bookingLocationFilter'),
        document.getElementById('logLocationFilter')
    ];

    filters.forEach(filter => {
        if (filter) {
            const currentValue = filter.value;
            filter.innerHTML = '<option value="">All Locations</option>';
            locations.forEach(loc => {
                filter.innerHTML += `<option value="${loc.location_id}">${escapeHTML(loc.name)}</option>`;
            });
            filter.value = currentValue;
        }
    });
}

// Location Management with Automatic Coordinates
function showAddLocationForm() {
    document.getElementById('addLocationForm').style.display = 'block';
}

function hideAddLocationForm() {
    document.getElementById('addLocationForm').style.display = 'none';
}

// Get current user's location
function getCurrentLocation() {
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            function(position) {
                document.getElementById('locLat').value = position.coords.latitude.toFixed(6);
                document.getElementById('locLng').value = position.coords.longitude.toFixed(6);
                showNotification('📍 Current location coordinates retrieved successfully', 'success');
            },
            function(error) {
                console.error('Geolocation error:', error);
                showNotification('Unable to get current location. Please enter coordinates manually.', 'error');
            },
            {
                enableHighAccuracy: true,
                timeout: 10000,
                maximumAge: 60000
            }
        );
    } else {
        showNotification('Geolocation is not supported by this browser.', 'error');
    }
}

// Get coordinates from address using OpenStreetMap Nominatim API
async function getCoordinatesFromAddress() {
    const address = document.getElementById('locAddress').value.trim();
    const name = document.getElementById('locName').value.trim();
    
    if (!address) return;
    
    try {
        // Combine name and address for better geocoding results
        const fullAddress = name ? `${name}, ${address}` : address;
        
        // Use OpenStreetMap Nominatim API (no API key required)
        const response = await fetch(
            `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(fullAddress)}&limit=1`,
            {
                headers: {
                    'User-Agent': 'SmartParkingSystem/1.0 (contact@smartparking.com)'
                }
            }
        );
        
        const data = await response.json();
        
        if (data && data.length > 0) {
            const result = data[0];
            document.getElementById('locLat').value = parseFloat(result.lat).toFixed(6);
            document.getElementById('locLng').value = parseFloat(result.lon).toFixed(6);
            showNotification(`📍 Coordinates found for "${result.display_name}"`, 'success');
        } else {
            showNotification('Could not find coordinates for this address. Please enter manually or try a different address.', 'warning');
        }
    } catch (error) {
        console.error('Geocoding error:', error);
        showNotification('Error getting coordinates. Please enter manually.', 'error');
    }
}

async function addLocation(event) {
    event.preventDefault();

    const locationData = {
        name: document.getElementById('locName').value,
        address: document.getElementById('locAddress').value,
        latitude: parseFloat(document.getElementById('locLat').value),
        longitude: parseFloat(document.getElementById('locLng').value),
        totalSlots: parseInt(document.getElementById('locTotalSlots').value),
        hourlyRate: parseFloat(document.getElementById('locHourlyRate').value),
        dailyRate: parseFloat(document.getElementById('locDailyRate').value) || null,
        hasCamera: document.getElementById('locHasCamera').checked
    };

    // Validate coordinates
    if (isNaN(locationData.latitude) || isNaN(locationData.longitude)) {
        showNotification('Please enter valid coordinates or use automatic detection.', 'error');
        return;
    }

    // Validate latitude and longitude ranges
    if (locationData.latitude < -90 || locationData.latitude > 90) {
        showNotification('Latitude must be between -90 and 90 degrees.', 'error');
        return;
    }

    if (locationData.longitude < -180 || locationData.longitude > 180) {
        showNotification('Longitude must be between -180 and 180 degrees.', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/admin/locations`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(locationData)
        });

        if (response.ok) {
            showNotification('Location added successfully', 'success');
            hideAddLocationForm();
            loadLocations();
            event.target.reset();
        } else {
            const data = await response.json();
            showNotification(data.error || 'Failed to add location', 'error');
        }
    } catch (error) {
        showNotification('Network error', 'error');
    }
}

// Bookings
async function loadBookings() {
    try {
        const status = document.getElementById('bookingStatusFilter').value;
        const locationId = document.getElementById('bookingLocationFilter').value;

        let url = `${API_URL}/admin/bookings?`;
        if (status) url += `status=${status}&`;
        if (locationId) url += `locationId=${locationId}&`;

        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const bookings = await response.json();
        const bookingsList = document.getElementById('bookingsList');

        if (bookings.length === 0) {
            bookingsList.innerHTML = '<p>No bookings found</p>';
            return;
        }

        let html = `
            <table>
                <thead>
                    <tr>
                        <th>Reference</th>
                        <th>User</th>
                        <th>Location</th>
                        <th>Slot</th>
                        <th>Vehicle</th>
                        <th>Start Time</th>
                        <th>End Time</th>
                        <th>Amount</th>
                        <th>Status</th>
                        <th>Payment</th>
                    </tr>
                </thead>
                <tbody>
        `;

        bookings.forEach(booking => {
            html += `
                <tr>
                    <td>${booking.booking_reference}</td>
                    <td>${booking.user_name}<br><small>${booking.user_phone}</small></td>
                    <td>${escapeHTML(booking.location_name)}</td>
                    <td>${escapeHTML(booking.slot_number || 'N/A')}</td>
                    <td>${escapeHTML(booking.license_plate || 'N/A')}</td>
                    <td>${new Date(booking.start_time).toLocaleString()}</td>
                    <td>${new Date(booking.end_time).toLocaleString()}</td>
                    <td>₹${booking.total_amount}</td>
                    <td><span class="status-badge status-${escapeHTML(booking.status)}">${escapeHTML(booking.status)}</span></td>
                    <td><span class="status-badge status-${escapeHTML(booking.payment_status)}">${escapeHTML(booking.payment_status)}</span></td>
                </tr>
            `;
        });

        html += '</tbody></table>';
        bookingsList.innerHTML = html;
    } catch (error) {
        showNotification('Failed to load bookings', 'error');
    }
}

// Entry/Exit Logs
async function loadLogs() {
    try {
        const eventType = document.getElementById('logEventFilter').value;
        const locationId = document.getElementById('logLocationFilter').value;

        let url = `${API_URL}/admin/logs?`;
        if (eventType) url += `eventType=${eventType}&`;
        if (locationId) url += `locationId=${locationId}&`;

        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const logs = await response.json();
        const logsList = document.getElementById('logsList');

        if (logs.length === 0) {
            logsList.innerHTML = '<p>No logs found</p>';
            return;
        }

        let html = `
            <table>
                <thead>
                    <tr>
                        <th>Time</th>
                        <th>Event</th>
                        <th>License Plate</th>
                        <th>Location</th>
                        <th>Booking Ref</th>
                        <th>Confidence</th>
                        <th>Verified</th>
                    </tr>
                </thead>
                <tbody>
        `;

        logs.forEach(log => {
            html += `
                <tr>
                    <td>${new Date(log.detected_time).toLocaleString()}</td>
                    <td><span class="event-badge event-${log.event_type}">${log.event_type}</span></td>
                    <td><strong>${escapeHTML(log.license_plate)}</strong></td>
                    <td>${escapeHTML(log.location_name)}</td>
                    <td>${escapeHTML(log.booking_reference || 'N/A')}</td>
                    <td>${log.confidence_score ? (log.confidence_score * 100).toFixed(1) + '%' : 'N/A'}</td>
                    <td>${log.is_verified ? '✅' : '❌'}</td>
                </tr>
            `;
        });

        html += '</tbody></table>';
        logsList.innerHTML = html;
    } catch (error) {
        showNotification('Failed to load logs', 'error');
    }
}

// Manual Entry/Exit Functions
function showManualEntryForm() {
    document.getElementById('manualEntryForm').style.display = 'block';
    document.getElementById('manualExitForm').style.display = 'none';
    populateLocationDropdowns();
}

function hideManualEntryForm() {
    document.getElementById('manualEntryForm').style.display = 'none';
}

function showManualExitForm() {
    document.getElementById('manualExitForm').style.display = 'block';
    document.getElementById('manualEntryForm').style.display = 'none';
    populateLocationDropdowns();
}

function hideManualExitForm() {
    document.getElementById('manualExitForm').style.display = 'none';
}

async function populateLocationDropdowns() {
    try {
        const response = await fetch(`${API_URL}/admin/locations`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const locations = await response.json();

        const entrySelect = document.getElementById('entryLocationId');
        const exitSelect = document.getElementById('exitLocationId');

        const options = locations.map(loc => 
            `<option value="${loc.location_id}">${escapeHTML(loc.name)}</option>`
        ).join('');

        if (entrySelect) entrySelect.innerHTML = '<option value="">Select Location</option>' + options;
        if (exitSelect) exitSelect.innerHTML = '<option value="">Select Location</option>' + options;
    } catch (error) {
        showNotification('Failed to load locations', 'error');
    }
}

async function processManualEntry(event) {
    event.preventDefault();

    const licensePlate = document.getElementById('entryLicensePlate').value;
    const locationId = document.getElementById('entryLocationId').value;
    const cameraId = document.getElementById('entryCameraId').value || 'MANUAL';

    try {
        const response = await fetch(`${API_URL}/alpr/entry`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                licensePlate,
                locationId: parseInt(locationId),
                imagePath: 'manual_entry',
                cameraId,
                confidenceScore: 1.0
            })
        });

        const data = await response.json();

        if (response.ok && data.success) {
            showNotification(`Entry processed for ${licensePlate}`, 'success');
            hideManualEntryForm();
            loadLogs();
            event.target.reset();
        } else {
            showNotification(data.error || 'Entry processing failed', 'error');
        }
    } catch (error) {
        showNotification('Network error', 'error');
    }
}

async function processManualExit(event) {
    event.preventDefault();

    const licensePlate = document.getElementById('exitLicensePlate').value;
    const locationId = document.getElementById('exitLocationId').value;
    const cameraId = document.getElementById('exitCameraId').value || 'MANUAL';

    try {
        const response = await fetch(`${API_URL}/alpr/exit`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                licensePlate,
                locationId: parseInt(locationId),
                imagePath: 'manual_exit',
                cameraId,
                confidenceScore: 1.0
            })
        });

        const data = await response.json();

        if (response.ok && data.success) {
            showNotification(`Exit processed for ${licensePlate}`, 'success');
            hideManualExitForm();
            loadLogs();
            event.target.reset();
        } else {
            showNotification(data.error || 'Exit processing failed', 'error');
        }
    } catch (error) {
        showNotification('Network error', 'error');
    }
}

// Revenue
async function loadRevenue() {
    try {
        const startDate = document.getElementById('revenueStartDate').value;
        const endDate = document.getElementById('revenueEndDate').value;

        let url = `${API_URL}/admin/revenue?`;
        if (startDate) url += `startDate=${startDate}&`;
        if (endDate) url += `endDate=${endDate}&`;

        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const revenue = await response.json();
        const revenueReport = document.getElementById('revenueReport');

        if (revenue.length === 0) {
            revenueReport.innerHTML = '<p>No revenue data found</p>';
            document.getElementById('revenueTotal').innerHTML = '';
            return;
        }

        let html = `
            <table>
                <thead>
                    <tr>
                        <th>Date</th>
                        <th>Location</th>
                        <th>Total Bookings</th>
                        <th>Total Revenue</th>
                        <th>Average Revenue</th>
                    </tr>
                </thead>
                <tbody>
        `;

        let totalRevenue = 0;
        let totalBookings = 0;

        revenue.forEach(item => {
            totalRevenue += parseFloat(item.total_revenue || 0);
            totalBookings += parseInt(item.total_bookings || 0);

            html += `
                <tr>
                    <td>${item.date ? new Date(item.date).toLocaleDateString() : 'N/A'}</td>
                    <td>${item.location_name}</td>
                    <td>${item.total_bookings}</td>
                    <td>₹${parseFloat(item.total_revenue).toFixed(2)}</td>
                    <td>₹${parseFloat(item.avg_revenue).toFixed(2)}</td>
                </tr>
            `;
        });

        html += '</tbody></table>';
        revenueReport.innerHTML = html;

        document.getElementById('revenueTotal').innerHTML = `
            <h3>Summary</h3>
            <p>Total Bookings: <strong>${totalBookings}</strong></p>
            <p>Total Revenue: <strong>₹${totalRevenue.toFixed(2)}</strong></p>
            <p>Average Revenue per Booking: <strong>₹${(totalRevenue / totalBookings).toFixed(2)}</strong></p>
        `;
    } catch (error) {
        showNotification('Failed to load revenue data', 'error');
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

// Set default dates for revenue
document.addEventListener('DOMContentLoaded', () => {
    const today = new Date();
    const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    
    if (document.getElementById('revenueStartDate')) {
        document.getElementById('revenueStartDate').valueAsDate = sevenDaysAgo;
    }
    if (document.getElementById('revenueEndDate')) {
        document.getElementById('revenueEndDate').valueAsDate = today;
    }
});

// Camera Capture Functions
let cameraStream = null;
let isCameraActive = false;

async function toggleCameraCapture() {
    const section = document.getElementById('cameraCaptureSection');
    const btn = document.getElementById('cameraToggleBtn');
    
    if (!isCameraActive) {
        section.style.display = 'block';
        await startCamera();
        btn.textContent = '❌ Close Camera';
        btn.classList.add('btn-danger');
        btn.classList.remove('btn-primary');
    } else {
        stopCamera();
        section.style.display = 'none';
        btn.textContent = '📷 Camera Capture';
        btn.classList.add('btn-primary');
        btn.classList.remove('btn-danger');
    }
}

async function startCamera() {
    try {
        const video = document.getElementById('cameraVideo');
        cameraStream = await navigator.mediaDevices.getUserMedia({ 
            video: { width: 1280, height: 720 } 
        });
        video.srcObject = cameraStream;
        isCameraActive = true;
        
        // Populate location dropdown
        await populateCameraLocations();
        
        showNotification('Camera started successfully', 'success');
    } catch (error) {
        showNotification('Failed to access camera: ' + error.message, 'error');
        console.error('Camera error:', error);
    }
}

function stopCamera() {
    if (cameraStream) {
        cameraStream.getTracks().forEach(track => track.stop());
        cameraStream = null;
    }
    isCameraActive = false;
    const video = document.getElementById('cameraVideo');
    if (video) {
        video.srcObject = null;
    }
}

async function populateCameraLocations() {
    try {
        const response = await fetch(`${API_URL}/admin/locations`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const locations = await response.json();

        const select = document.getElementById('cameraLocationSelect');
        select.innerHTML = '<option value="">Select Location</option>' + 
            locations.map(loc => `<option value="${loc.location_id}">${escapeHTML(loc.name)}</option>`).join('');
    } catch (error) {
        console.error('Failed to load locations:', error);
    }
}

async function captureAndRecognize() {
    const eventType = document.getElementById('cameraEventType').value;
    const locationId = document.getElementById('cameraLocationSelect').value;
    
    if (!locationId) {
        showNotification('Please select a location', 'error');
        return;
    }
    
    if (!isCameraActive) {
        showNotification('Camera is not active', 'error');
        return;
    }

    try {
        // Capture image from video
        const video = document.getElementById('cameraVideo');
        const canvas = document.getElementById('cameraCanvas');
        const context = canvas.getContext('2d');
        
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        context.drawImage(video, 0, 0);
        
        // Convert to blob
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.95));
        
        // Show loading
        document.getElementById('captureResult').innerHTML = '🔄 Processing image...';
        
        // Send to OCR service
        const formData = new FormData();
        formData.append('image', blob, 'capture.jpg');
        
        const ocrResponse = await fetch(`${API_URL}/alpr/recognize`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: formData
        });
        
        const ocrData = await ocrResponse.json();
        
        if (ocrData.success && ocrData.license_plate) {
            const licensePlate = ocrData.license_plate;
            const confidence = ocrData.confidence || 0;
            
            // Display result
            document.getElementById('captureResult').innerHTML = `
                <h4 style="color: #16a34a;">✅ License Plate Detected</h4>
                <p><strong>Plate:</strong> <span style="font-size: 1.5em; color: #2563eb;">${licensePlate}</span></p>
                <p><strong>Confidence:</strong> ${(confidence * 100).toFixed(1)}%</p>
                <p><strong>Event:</strong> ${eventType.toUpperCase()}</p>
                <button onclick="processDetectedPlate('${licensePlate}', '${eventType}', ${locationId}, ${confidence})" class="btn-primary" style="margin-top: 10px;">Process ${eventType.toUpperCase()}</button>
            `;
        } else {
            document.getElementById('captureResult').innerHTML = `
                <h4 style="color: #dc2626;">❌ No License Plate Detected</h4>
                <p>${ocrData.error || 'Could not detect a license plate in the image'}</p>
                <button onclick="captureAndRecognize()" class="btn-primary" style="margin-top: 10px;">Try Again</button>
            `;
        }
    } catch (error) {
        document.getElementById('captureResult').innerHTML = `
            <h4 style="color: #dc2626;">❌ Error</h4>
            <p>${error.message}</p>
        `;
        showNotification('Recognition failed: ' + error.message, 'error');
    }
}

async function processDetectedPlate(licensePlate, eventType, locationId, confidence) {
    try {
        const endpoint = eventType === 'entry' ? 'entry' : 'exit';
        
        const response = await fetch(`${API_URL}/alpr/${endpoint}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                licensePlate,
                locationId: parseInt(locationId),
                imagePath: 'camera_capture',
                cameraId: 'ADMIN_CAMERA',
                confidenceScore: confidence
            })
        });

        const data = await response.json();

        if (response.ok && data.success) {
            showNotification(`${eventType.toUpperCase()} processed successfully for ${licensePlate}`, 'success');
            document.getElementById('captureResult').innerHTML = `
                <h4 style="color: #16a34a;">✅ ${eventType.toUpperCase()} Processed</h4>
                <p><strong>License Plate:</strong> ${licensePlate}</p>
                <p><strong>Status:</strong> Success</p>
                <p style="margin-top: 15px;"><button onclick="captureAndRecognize()" class="btn-primary">Capture Another</button></p>
            `;
            loadLogs();
        } else {
            showNotification(data.error || `${eventType} processing failed`, 'error');
            document.getElementById('captureResult').innerHTML = `
                <h4 style="color: #dc2626;">❌ Processing Failed</h4>
                <p>${data.error || 'Unknown error'}</p>
                <p style="margin-top: 15px;"><button onclick="captureAndRecognize()" class="btn-primary">Try Again</button></p>
            `;
        }
    } catch (error) {
        showNotification('Network error', 'error');
        document.getElementById('captureResult').innerHTML = `
            <h4 style="color: #dc2626;">❌ Error</h4>
            <p>${error.message}</p>
        `;
    }
}

// ===== CHARTS & ANALYTICS =====
function initializeCharts() {
    loadBookingTrendChart();
    loadRevenueChart();
    loadSlotOccupancyChart();
    loadPeakHoursChart();
}

async function loadBookingTrendChart() {
    const ctx = document.getElementById('bookingTrendChart');
    if (!ctx) return;
    
    try {
        const period = document.getElementById('bookingTrendPeriod')?.value || '30';
        const response = await fetch(`${API_URL}/admin/analytics/bookings-trend?days=${period}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        const data = await response.json();
        
        const isDark = document.body.classList.contains('dark-mode');
        const textColor = isDark ? '#e2e8f0' : '#2d3748';
        const gridColor = isDark ? '#4a5568' : '#e2e8f0';
        
        if (charts.bookingTrend) {
            charts.bookingTrend.destroy();
        }
        
        charts.bookingTrend = new Chart(ctx, {
            type: 'line',
            data: {
                labels: data.labels || getLast30Days(),
                datasets: [{
                    label: 'Bookings',
                    data: data.values || Array(30).fill(0),
                    borderColor: '#667eea',
                    backgroundColor: 'rgba(102, 126, 234, 0.1)',
                    tension: 0.4,
                    fill: true
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { labels: { color: textColor } }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: { color: textColor },
                        grid: { color: gridColor }
                    },
                    x: {
                        ticks: { 
                            color: textColor,
                            maxRotation: 45,
                            minRotation: 45
                        },
                        grid: { color: gridColor }
                    }
                }
            }
        });
    } catch (error) {
        console.error('Failed to load booking trend:', error);
        initBookingTrendChart(); // Fallback to default
    }
}

async function loadRevenueChart() {
    const ctx = document.getElementById('revenueChart');
    if (!ctx) return;
    
    try {
        const period = document.getElementById('revenuePeriod')?.value || '30';
        const response = await fetch(`${API_URL}/admin/analytics/revenue-trend?days=${period}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        const data = await response.json();
        
        const isDark = document.body.classList.contains('dark-mode');
        const textColor = isDark ? '#e2e8f0' : '#2d3748';
        const gridColor = isDark ? '#4a5568' : '#e2e8f0';
        
        if (charts.revenue) {
            charts.revenue.destroy();
        }
        
        charts.revenue = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: data.labels || getLast30Days(),
                datasets: [{
                    label: 'Revenue (₹)',
                    data: data.values || Array(30).fill(0),
                    backgroundColor: 'rgba(102, 126, 234, 0.8)',
                    borderRadius: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { labels: { color: textColor } }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: { color: textColor },
                        grid: { color: gridColor }
                    },
                    x: {
                        ticks: { color: textColor },
                        grid: { color: gridColor }
                    }
                }
            }
        });
    } catch (error) {
        console.error('Failed to load revenue chart:', error);
        initRevenueChart(); // Fallback
    }
}

async function loadSlotOccupancyChart() {
    const ctx = document.getElementById('slotOccupancyChart');
    if (!ctx) return;
    
    try {
        const response = await fetch(`${API_URL}/admin/analytics/slot-occupancy`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        const data = await response.json();
        
        const isDark = document.body.classList.contains('dark-mode');
        const textColor = isDark ? '#e2e8f0' : '#2d3748';
        
        if (charts.slotOccupancy) {
            charts.slotOccupancy.destroy();
        }
        
        charts.slotOccupancy = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['Occupied', 'Reserved', 'Available'],
                datasets: [{
                    data: [
                        data.occupied || 0,
                        data.reserved || 0,
                        data.available || 0
                    ],
                    backgroundColor: ['#e74c3c', '#f39c12', '#2ecc71'],
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { color: textColor, padding: 20 }
                    }
                }
            }
        });
    } catch (error) {
        console.error('Failed to load slot occupancy:', error);
        initSlotOccupancyChart(); // Fallback
    }
}

async function loadPeakHoursChart() {
    const ctx = document.getElementById('peakHoursChart');
    if (!ctx) return;
    
    try {
        const response = await fetch(`${API_URL}/admin/analytics/peak-hours`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        const data = await response.json();
        
        const isDark = document.body.classList.contains('dark-mode');
        const textColor = isDark ? '#e2e8f0' : '#2d3748';
        const gridColor = isDark ? '#4a5568' : '#e2e8f0';
        
        if (charts.peakHours) {
            charts.peakHours.destroy();
        }
        
        charts.peakHours = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: data.labels || ['12AM', '4AM', '8AM', '12PM', '4PM', '8PM'],
                datasets: [{
                    label: 'Vehicles',
                    data: data.values || Array(6).fill(0),
                    backgroundColor: 'rgba(118, 75, 162, 0.8)',
                    borderRadius: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { labels: { color: textColor } }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: { color: textColor },
                        grid: { color: gridColor }
                    },
                    x: {
                        ticks: { color: textColor },
                        grid: { color: gridColor }
                    }
                }
            }
        });
    } catch (error) {
        console.error('Failed to load peak hours:', error);
        initPeakHoursChart(); // Fallback
    }
}

function updateBookingTrend() {
    loadBookingTrendChart();
}

function updateRevenueChart() {
    loadRevenueChart();
}

function updateChartsTheme() {
    const isDark = document.body.classList.contains('dark-mode');
    const textColor = isDark ? '#e2e8f0' : '#2d3748';
    const gridColor = isDark ? '#4a5568' : '#e2e8f0';
    
    Object.values(charts).forEach(chart => {
        if (chart && chart.options) {
            if (chart.options.plugins && chart.options.plugins.legend) {
                chart.options.plugins.legend.labels.color = textColor;
            }
            if (chart.options.scales) {
                if (chart.options.scales.x) {
                    chart.options.scales.x.ticks.color = textColor;
                    chart.options.scales.x.grid.color = gridColor;
                }
                if (chart.options.scales.y) {
                    chart.options.scales.y.ticks.color = textColor;
                    chart.options.scales.y.grid.color = gridColor;
                }
            }
            chart.update();
        }
    });
}

function updateAllCharts() {
    loadBookingTrendChart();
    loadRevenueChart();
    loadSlotOccupancyChart();
    loadPeakHoursChart();
}

function getLast30Days() {
    const days = [];
    for (let i = 29; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        days.push(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
    }
    return days;
}

// ===== MAP INITIALIZATION =====
function initializeMap() {
    if (parkingMap) return; // Already initialized
    
    setTimeout(() => {
        const mapElement = document.getElementById('parkingMap');
        if (!mapElement) return;
        
        parkingMap = L.map('parkingMap').setView([28.6139, 77.2090], 12);
        
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors'
        }).addTo(parkingMap);
        
        // Load locations and add markers
        loadMapLocations();
    }, 100);
}

async function loadMapLocations() {
    try {
        const response = await fetch(`${API_URL}/admin/locations`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        allMapLocations = await response.json();
        
        allMapLocations.forEach(loc => {
            const marker = L.marker([loc.latitude, loc.longitude]).addTo(parkingMap);
            marker.bindPopup(`
                <strong>${escapeHTML(loc.name)}</strong><br>
                Available: ${loc.available_slots}/${loc.total_slots}<br>
                Rate: ₹${loc.hourly_rate}/hr
            `);
        });
    } catch (error) {
        console.error('Failed to load map locations:', error);
    }
}

// ===== STUB FUNCTIONS FOR NEW SECTIONS =====
let allUsers = [];
let allVehicles = [];
let allMapLocations = [];

async function loadSlots() {
    try {
        // First populate location dropdown if not already populated
        await populateSlotLocationDropdown();
        
        const locationId = document.getElementById('slotLocationFilter').value;
        const status = document.getElementById('slotStatusFilter').value;

        let url = `${API_URL}/admin/slots?`;
        if (locationId) url += `locationId=${locationId}&`;
        if (status) url += `status=${status}&`;

        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const slots = await response.json();
        displaySlots(slots);
    } catch (error) {
        console.error('Failed to load slots:', error);
        showNotification('Failed to load slots', 'error');
    }
}

async function populateSlotLocationDropdown() {
    try {
        const response = await fetch(`${API_URL}/admin/locations`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const locations = await response.json();
        
        // Populate filter dropdown
        const filterDropdown = document.getElementById('slotLocationFilter');
        if (filterDropdown && filterDropdown.children.length <= 1) { // Only default option
            filterDropdown.innerHTML = '<option value="">All Locations</option>';
            locations.forEach(location => {
                const option = document.createElement('option');
                option.value = location.location_id;
                option.textContent = location.name;
                filterDropdown.appendChild(option);
            });
        }
        
        // Populate add slot form dropdown
        const addFormDropdown = document.getElementById('slotLocationId');
        if (addFormDropdown) {
            addFormDropdown.innerHTML = '<option value="">Select Location</option>';
            locations.forEach(location => {
                const option = document.createElement('option');
                option.value = location.location_id;
                option.textContent = `${location.name} (${location.available_slots}/${location.total_slots} available)`;
                addFormDropdown.appendChild(option);
            });
        }
    } catch (error) {
        console.error('Failed to load locations for dropdown:', error);
    }
}

function displaySlots(slots) {
    const slotsList = document.getElementById('slotsList');
    if (!slotsList) return;
    
    if (slots.length === 0) {
        slotsList.innerHTML = '<p style="text-align: center; padding: 2rem; color: var(--text-secondary);">No slots found</p>';
        return;
    }
    
    let html = '<div class="slots-grid-container">';
    
    slots.forEach(slot => {
        html += `
            <div class="slot-card status-${slot.status}">
                <div class="slot-header">
                    <h4>${slot.slot_number}</h4>
                    <span class="slot-status status-${slot.status}">${slot.status}</span>
                </div>
                <div class="slot-details">
                    <p><strong>Type:</strong> ${slot.slot_type}</p>
                    <p><strong>Floor:</strong> ${slot.floor || 'N/A'}</p>
                    <p><strong>Location:</strong> ${slot.location_name}</p>
                </div>
                <div class="slot-actions">
                    <button onclick="changeSlotStatus(${slot.slot_id}, 'maintenance')" class="btn-warning btn-small">🔧 Maintenance</button>
                    <button onclick="deleteSlot(${slot.slot_id})" class="btn-danger btn-small">🗑️ Delete</button>
                </div>
            </div>
        `;
    });
    
    html += '</div>';
    slotsList.innerHTML = html;
}

function showAddSlotForm() {
    document.getElementById('addSlotForm').style.display = 'block';
    // Make sure location dropdown is populated
    populateSlotLocationDropdown();
}

function hideAddSlotForm() {
    document.getElementById('addSlotForm').style.display = 'none';
    document.getElementById('addSlotsForm').reset();
}

// Toggle multiple slots fields
document.getElementById('addMultipleSlots').addEventListener('change', function() {
    document.getElementById('multipleSlotsFields').style.display = this.checked ? 'block' : 'none';
});

async function addSlots(event) {
    event.preventDefault();
    
    const locationId = document.getElementById('slotLocationId').value;
    const slotNumber = document.getElementById('slotNumber').value;
    const slotType = document.getElementById('slotType').value;
    const floor = document.getElementById('slotFloor').value;
    const addMultiple = document.getElementById('addMultipleSlots').checked;
    const slotCount = parseInt(document.getElementById('slotCount').value) || 1;
    
    if (!locationId) {
        showNotification('Please select a location', 'error');
        return;
    }
    
    if (!slotNumber) {
        showNotification('Please enter a slot number', 'error');
        return;
    }
    
    try {
        let slots = [];
        
        if (addMultiple) {
            // Generate multiple slots
            for (let i = 0; i < slotCount; i++) {
                // Try to parse number from slotNumber to increment it
                const match = slotNumber.match(/^([A-Za-z]*)(\d+)([A-Za-z]*)$/);
                if (match) {
                    const prefix = match[1] || '';
                    const number = parseInt(match[2]);
                    const suffix = match[3] || '';
                    const newNumber = number + i;
                    slots.push({
                        slotNumber: `${prefix}${newNumber.toString().padStart(match[2].length, '0')}${suffix}`,
                        slotType: slotType,
                        floor: floor
                    });
                } else {
                    // If no number pattern, just append number
                    slots.push({
                        slotNumber: `${slotNumber}-${i+1}`,
                        slotType: slotType,
                        floor: floor
                    });
                }
            }
        } else {
            // Single slot
            slots.push({
                slotNumber: slotNumber,
                slotType: slotType,
                floor: floor
            });
        }
        
        const response = await fetch(`${API_URL}/admin/locations/${locationId}/slots`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ slots: slots })
        });
        
        if (response.ok) {
            showNotification(`Successfully added ${slots.length} slot(s)`, 'success');
            hideAddSlotForm();
            loadSlots();
            
            // Reset form
            document.getElementById('addSlotsForm').reset();
            document.getElementById('multipleSlotsFields').style.display = 'none';
            document.getElementById('addMultipleSlots').checked = false;
        } else {
            const data = await response.json();
            showNotification(data.error || 'Failed to add slots', 'error');
        }
    } catch (error) {
        console.error('Failed to add slots:', error);
        showNotification('Network error while adding slots', 'error');
    }
}

async function changeSlotStatus(slotId, newStatus) {
    if (!confirm(`Are you sure you want to change this slot to ${newStatus} status?`)) {
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/admin/slots/${slotId}/status`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ status: newStatus })
        });
        
        if (response.ok) {
            showNotification('Slot status updated successfully', 'success');
            loadSlots();
        } else {
            const data = await response.json();
            showNotification(data.error || 'Failed to update slot status', 'error');
        }
    } catch (error) {
        console.error('Failed to update slot status:', error);
        showNotification('Network error while updating slot status', 'error');
    }
}

async function deleteSlot(slotId) {
    if (!confirm('Are you sure you want to delete this slot? This action cannot be undone.')) {
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/admin/slots/${slotId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        if (response.ok) {
            showNotification('Slot deleted successfully', 'success');
            loadSlots();
        } else {
            const data = await response.json();
            showNotification(data.error || 'Failed to delete slot', 'error');
        }
    } catch (error) {
        console.error('Failed to delete slot:', error);
        showNotification('Network error while deleting slot', 'error');
    }
}

async function loadUsers() {
    try {
        const response = await fetch(`${API_URL}/admin/users`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (response.ok) {
            allUsers = await response.json();
            displayUsers(allUsers);
        }
    } catch (error) {
        console.error('Failed to load users:', error);
        showNotification('Failed to load users', 'error');
    }
}

function displayUsers(users) {
    const usersList = document.getElementById('usersList');
    if (!usersList) return;
    
    if (users.length === 0) {
        usersList.innerHTML = '<p style="text-align: center; padding: 2rem; color: var(--text-secondary);">No users found</p>';
        return;
    }
    
    let html = `
        <table>
            <thead>
                <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Phone</th>
                    <th>Role</th>
                    <th>Wallet Balance</th>
                    <th>Joined</th>
                </tr>
            </thead>
            <tbody>
    `;
    
    users.forEach(user => {
        html += `
            <tr>
                <td>${escapeHTML(user.name || 'N/A')}</td>
                <td>${escapeHTML(user.email)}</td>
                <td>${escapeHTML(user.phone || 'N/A')}</td>
                <td><span class="status-badge status-${escapeHTML(user.role)}">${escapeHTML(user.role)}</span></td>
                <td>₹${parseFloat(user.wallet_balance || 0).toFixed(2)}</td>
                <td>${new Date(user.created_at).toLocaleDateString()}</td>
            </tr>
        `;
    });
    
    html += '</tbody></table>';
    usersList.innerHTML = html;
}

function searchUsers() {
    const searchTerm = document.getElementById('userSearch').value.toLowerCase();
    const filtered = allUsers.filter(user => 
        (user.name && user.name.toLowerCase().includes(searchTerm)) ||
        (user.email && user.email.toLowerCase().includes(searchTerm)) ||
        (user.phone && user.phone.toLowerCase().includes(searchTerm))
    );
    displayUsers(filtered);
}

async function loadVehicles() {
    try {
        const response = await fetch(`${API_URL}/admin/vehicles`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (response.ok) {
            allVehicles = await response.json();
            displayVehicles(allVehicles);
        }
    } catch (error) {
        console.error('Failed to load vehicles:', error);
        showNotification('Failed to load vehicles', 'error');
    }
}

function displayVehicles(vehicles) {
    const vehiclesList = document.getElementById('vehiclesList');
    if (!vehiclesList) return;
    
    if (vehicles.length === 0) {
        vehiclesList.innerHTML = '<p style="text-align: center; padding: 2rem; color: var(--text-secondary);">No vehicles found</p>';
        return;
    }
    
    let html = `
        <table>
            <thead>
                <tr>
                    <th>License Plate</th>
                    <th>Owner</th>
                    <th>Make/Model</th>
                    <th>Type</th>
                    <th>Color</th>
                    <th>Registered</th>
                </tr>
            </thead>
            <tbody>
    `;
    
    vehicles.forEach(vehicle => {
        html += `
            <tr>
                <td><strong>${escapeHTML(vehicle.license_plate)}</strong></td>
                <td>${escapeHTML(vehicle.user_name || 'N/A')}</td>
                <td>${escapeHTML(vehicle.make)} ${escapeHTML(vehicle.model)}</td>
                <td><span class="status-badge">${escapeHTML(vehicle.vehicle_type)}</span></td>
                <td>${escapeHTML(vehicle.color)}</td>
                <td>${new Date(vehicle.created_at).toLocaleDateString()}</td>
            </tr>
        `;
    });
    
    html += '</tbody></table>';
    vehiclesList.innerHTML = html;
}

function searchVehicles() {
    const searchTerm = document.getElementById('vehicleSearch').value.toLowerCase();
    const filtered = allVehicles.filter(vehicle => 
        vehicle.license_plate.toLowerCase().includes(searchTerm) ||
        (vehicle.make && vehicle.make.toLowerCase().includes(searchTerm)) ||
        (vehicle.model && vehicle.model.toLowerCase().includes(searchTerm))
    );
    displayVehicles(filtered);
}

async function loadAnalytics() {
    showNotification('Loading analytics...', 'info');
}

function filterMapLocations() {
    const searchTerm = document.getElementById('mapSearch').value.toLowerCase();
    const slotFilter = document.getElementById('mapSlotFilter').value;
    const priceFilter = document.getElementById('mapPriceFilter').value;
    
    if (!parkingMap) return;
    
    // Clear existing markers
    parkingMap.eachLayer(layer => {
        if (layer instanceof L.Marker) {
            parkingMap.removeLayer(layer);
        }
    });
    
    // Filter and re-add markers
    let filtered = allMapLocations;
    
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
        const marker = L.marker([loc.latitude, loc.longitude]).addTo(parkingMap);
        marker.bindPopup(`
            <strong>${escapeHTML(loc.name)}</strong><br>
            Available: ${loc.available_slots}/${loc.total_slots}<br>
            Rate: ₹${loc.hourly_rate}/hr
        `);
    });
}

function saveSettings() {
    showNotification('Settings saved successfully!', 'success');
}

function generateReport(type) {
    showNotification(`Generating ${type} report...`, 'info');
}

function exportRevenuePDF() {
    showNotification('Exporting to PDF...', 'info');
}

function exportRevenueExcel() {
    showNotification('Exporting to Excel...', 'info');
}
