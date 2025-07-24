const jwt = require('jsonwebtoken');
const { prisma } = require('../lib/prisma');

const authMiddleware = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ message: 'Access denied. No token provided.' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Find user and check if still active
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId }
    });

    if (!user) {
      return res.status(401).json({ message: 'Invalid token. User not found.' });
    }

    if (!user.isActive) {
      return res.status(401).json({ message: 'Account has been deactivated' });
    }

    // Update last seen
    await prisma.user.update({
      where: { id: decoded.userId },
      data: { lastSeen: new Date() }
    });

    req.user = {
      userId: user.id,
      role: user.role,
      email: user.email
    };

    return next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ message: 'Invalid token' });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Token expired' });
    }
    
    console.error('Auth middleware error:', error);
    return res.status(500).json({ message: 'Server error during authentication' });
  }
};

const optionalAuth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return next();
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId }
    });

    if (user && user.isActive) {
      req.user = {
        userId: user.id,
        role: user.role,
        email: user.email
      };
    }

    return next();
  } catch (error) {
    // Continue without authentication for optional auth
    return next();
  }
};

const requireRole = (role) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    if (req.user.role !== role) {
      return res.status(403).json({ message: `Access denied. ${role} role required.` });
    }

    return next();
  };
};

const requireClient = requireRole('CLIENT');
const requireReader = requireRole('READER');
const requireAdmin = requireRole('ADMIN');

const requireReaderOrAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  if (req.user.role !== 'READER' && req.user.role !== 'ADMIN') {
    return res.status(403).json({ message: 'Access denied. Reader or Admin role required.' });
  }

  return next();
};

// Rate limiting middleware for sensitive operations
const rateLimitSensitive = (req, res, next) => {
  // TODO: Implement proper rate limiting with Redis or in-memory store
  // For now, just pass through
  next();
};

module.exports = {
  authMiddleware,
  optionalAuth,
  requireClient,
  requireReader,
  requireAdmin,
  requireReaderOrAdmin,
  rateLimitSensitive
};