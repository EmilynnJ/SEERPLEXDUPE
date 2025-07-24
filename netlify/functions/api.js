const express = require('express');
const serverless = require('serverless-http');
const cors = require('cors');
require('dotenv').config();

const { prisma, healthCheck } = require('../../server/lib/prisma');

// Import routes from server directory (more comprehensive implementations)
const authRoutes = require('../../server/routes/auth');
const userRoutes = require('../../server/routes/users');
const sessionRoutes = require('../../server/routes/sessions');
const stripeRoutes = require('../../server/routes/stripe');
const messageRoutes = require('../../server/routes/messages');
const adminRoutes = require('../../server/routes/admin');

// Import middleware from server directory
const { authMiddleware } = require('../../server/middleware/auth');

// Initialize Express
const app = express();

// Initialize Prisma Client connection for serverless environment
prisma
  .$connect()
  .then(() => console.log('Connected to database via Prisma'))
  .catch(err => console.error('Prisma connection error:', err));

// Middleware
app.use(cors({
  origin: process.env.CLIENT_URL || "*",
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes - using path relative to /.netlify/functions/api
app.use('/auth', authRoutes);
app.use('/users', userRoutes);
app.use('/sessions', sessionRoutes);
app.use('/stripe', stripeRoutes);
app.use('/messages', messageRoutes);
app.use('/admin', adminRoutes);

// Health check
app.get('/health', async (req, res) => {
  const status = await healthCheck();
  res.json({
    status: status.status,
    timestamp: status.timestamp,
    environment: process.env.NODE_ENV,
    ...(status.error ? { error: status.error } : {})
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    message: 'Something went wrong!',
    error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ message: 'Route not found' });
});

// Export the serverless handler
module.exports.handler = serverless(app);