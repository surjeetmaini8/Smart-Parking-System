const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const db = require('./db');
const config = require('../config.json');
const { startScheduler } = require('./jobs/scheduler');
const { rateLimit } = require('./middleware/rateLimit');

// Import routes
const authRoutes = require('./routes/auth');
const parkingRoutes = require('./routes/parking');
const bookingRoutes = require('./routes/bookings');
const vehicleRoutes = require('./routes/vehicles');
const paymentRoutes = require('./routes/payments');
const alprRoutes = require('./routes/alpr');
const adminRoutes = require('./routes/admin');

const app = express();
const server = http.createServer(app);

const configuredOrigins = (process.env.CORS_ORIGINS || '').split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

const socketCorsOrigin = configuredOrigins.length ? configuredOrigins : true;

const io = socketIo(server, {
  cors: {
    origin: socketCorsOrigin,
    methods: ['GET', 'POST']
  }
});

// Basic security and request limits. Keep CORS restricted in production.
const corsOptions = configuredOrigins.length
  ? { origin: configuredOrigins, credentials: false }
  : { origin: process.env.NODE_ENV === 'production' ? false : true };

app.disable('x-powered-by');
app.use(cors(corsOptions));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(rateLimit({ windowMs: 60_000, max: 300 }));
app.use(express.static(path.join(__dirname, '../frontend')));

// Make io accessible to routes
app.set('io', io);

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/parking', parkingRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/alpr', alprRoutes);
app.use('/api/admin', adminRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date() });
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/admin.html'));
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);

  socket.on('join-location', (locationId) => {
    socket.join(`location-${locationId}`);
    console.log(`Client ${socket.id} joined location ${locationId}`);
  });

  socket.on('disconnect', () => {
    console.log('🔌 Client disconnected:', socket.id);
  });
});

// Global broadcast function for real-time updates
global.broadcastUpdate = (event, data) => {
  io.emit(event, data);
};

global.broadcastToLocation = (locationId, event, data) => {
  io.to(`location-${locationId}`).emit(event, data);
};

// Unknown API routes
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  const status = err.status || 500;
  res.status(status).json({
    error: process.env.NODE_ENV === 'production'
      ? (status >= 500 ? 'Internal Server Error' : 'Request failed')
      : (err.message || 'Internal Server Error')
  });
});

// Fail fast when security-critical configuration is missing.
const jwtSecret = process.env.JWT_SECRET || '';
if (jwtSecret.length < 32 || /change|your_|replace/i.test(jwtSecret)) {
  throw new Error('JWT_SECRET must be a strong, unique 32+ character value');
}
if (process.env.NODE_ENV === 'production' &&
    (!process.env.ALPR_INTERNAL_TOKEN || process.env.ALPR_INTERNAL_TOKEN.length < 32)) {
  throw new Error('ALPR_INTERNAL_TOKEN must be configured in production');
}

// Start scheduler for background jobs
startScheduler();

// Start server
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   🅿️  Smart Parking System Server     ║
║   Server running on port ${PORT}         ║
║   http://localhost:${PORT}               ║
╚════════════════════════════════════════╝
  `);
});

module.exports = { app, io };