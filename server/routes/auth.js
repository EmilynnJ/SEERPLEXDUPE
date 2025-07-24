const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { prisma, userHelpers, handlePrismaError } = require('../lib/prisma');
const { authMiddleware, rateLimitSensitive } = require('../middleware/auth');
const { validateUserRegistration, validateUserLogin } = require('../middleware/validation');

const router = express.Router();

// Generate JWT token
const generateToken = (userId, role) => {
  return jwt.sign(
    { userId, role },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  );
};

// Register new user (clients only - readers created by admin)
router.post('/signup', rateLimitSensitive, validateUserRegistration, async (req, res) => {
  try {
    const { email, password, name } = req.body;

    // Check if user already exists
    const existingUser = await userHelpers.findByEmail(email);
    if (existingUser) {
      return res.status(400).json({ message: 'User with this email already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create new client user
    const userData = {
      email,
      password: hashedPassword,
      role: 'CLIENT',
      name: name || null,
      balance: 0,
      totalEarnings: 0,
      pendingEarnings: 0,
      paidEarnings: 0,
      isVerified: false,
      isActive: true,
      preferences: {}
    };

    const user = await userHelpers.createUser(userData);

    // Generate token
    const token = generateToken(user.id, user.role);

    // Return user data without password
    const userResponse = {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      avatar: user.avatar,
      bio: user.bio,
      balance: user.balance,
      isVerified: user.isVerified,
      createdAt: user.createdAt
    };

    res.status(201).json({
      success: true,
      message: 'Account created successfully',
      token,
      user: userResponse
    });

  } catch (error) {
    console.error('Signup error:', error);
    
    if (error.message.includes('Unique constraint failed')) {
      return res.status(400).json({ message: 'Email already exists' });
    }
    
    res.status(500).json({ 
      message: 'Server error during registration',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Login user
router.post('/login', rateLimitSensitive, validateUserLogin, async (req, res) => {
  try {
    const { email, password } = req.body;

    // Find user by email
    const user = await prisma.user.findUnique({
      where: { email }
    });

    if (!user) {
      return res.status(400).json({ message: 'Invalid email or password' });
    }

    // Check if account is active
    if (!user.isActive) {
      return res.status(403).json({ message: 'Account has been deactivated. Please contact support.' });
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(400).json({ message: 'Invalid email or password' });
    }

    // Update last seen
    await userHelpers.updateLastSeen(user.id);

    // Generate token
    const token = generateToken(user.id, user.role);

    // Return user data without password
    const userResponse = {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      avatar: user.avatar,
      bio: user.bio,
      specialties: user.specialties,
      rating: user.rating,
      balance: user.balance,
      totalEarnings: user.totalEarnings,
      pendingEarnings: user.pendingEarnings,
      videoRate: user.videoRate,
      audioRate: user.audioRate,
      chatRate: user.chatRate,
      isOnline: user.isOnline,
      isVerified: user.isVerified,
      lastSeen: user.lastSeen,
      preferences: user.preferences
    };

    res.json({
      success: true,
      message: 'Login successful',
      token,
      user: userResponse
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ 
      message: 'Server error during login',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get current user
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId }
    });
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Return user data without password
    const userResponse = {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      avatar: user.avatar,
      bio: user.bio,
      specialties: user.specialties,
      rating: user.rating,
      balance: user.balance,
      totalEarnings: user.totalEarnings,
      pendingEarnings: user.pendingEarnings,
      videoRate: user.videoRate,
      audioRate: user.audioRate,
      chatRate: user.chatRate,
      isOnline: user.isOnline,
      isVerified: user.isVerified,
      lastSeen: user.lastSeen,
      preferences: user.preferences,
      availability: user.availability
    };

    res.json({
      success: true,
      user: userResponse
    });

  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ 
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Refresh token
router.post('/refresh', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId }
    });
    
    if (!user || !user.isActive) {
      return res.status(401).json({ message: 'User not found or inactive' });
    }

    // Generate new token
    const token = generateToken(user.id, user.role);

    const userResponse = {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      avatar: user.avatar,
      balance: user.balance,
      totalEarnings: user.totalEarnings,
      pendingEarnings: user.pendingEarnings,
      isVerified: user.isVerified
    };

    res.json({
      success: true,
      token,
      user: userResponse
    });

  } catch (error) {
    console.error('Token refresh error:', error);
    res.status(500).json({ message: 'Server error during token refresh' });
  }
});

// Logout (client-side token removal, but we can track it)
router.post('/logout', authMiddleware, async (req, res) => {
  try {
    // Update user's last seen and set offline if reader
    const updateData = {
      lastSeen: new Date()
    };

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId }
    });

    if (user && user.role === 'READER') {
      updateData.isOnline = false;
    }

    await prisma.user.update({
      where: { id: req.user.userId },
      data: updateData
    });

    res.json({
      success: true,
      message: 'Logged out successfully'
    });

  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ message: 'Server error during logout' });
  }
});

// Request password reset
router.post('/forgot-password', rateLimitSensitive, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const user = await userHelpers.findByEmail(email);
    
    // Always return success to prevent email enumeration
    res.json({
      success: true,
      message: 'If an account with that email exists, a password reset link has been sent.'
    });

    // TODO: Implement actual password reset email logic
    if (user) {
      console.log(`Password reset requested for user: ${user.email}`);
      // Generate reset token and send email
    }

  } catch (error) {
    console.error('Password reset error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Verify email (placeholder for future implementation)
router.post('/verify-email', authMiddleware, async (req, res) => {
  try {
    const { verificationCode } = req.body;

    // TODO: Implement email verification logic
    
    res.json({
      success: true,
      message: 'Email verification feature coming soon'
    });

  } catch (error) {
    console.error('Email verification error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;