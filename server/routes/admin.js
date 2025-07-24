const express = require('express');
const { prisma, handlePrismaError } = require('../lib/prisma');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const { validateUserRegistration, validateProfileUpdate } = require('../middleware/validation');
const bcrypt = require('bcryptjs');

const router = express.Router();

// All admin routes require admin authentication
router.use(authMiddleware, requireAdmin);

// Get all readers
router.get('/readers', async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20, 
      status = 'all',
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    // Build query
    const where = { role: 'READER' };
    
    if (status === 'active') {
      where.isActive = true;
    } else if (status === 'inactive') {
      where.isActive = false;
    } else if (status === 'online') {
      where.isOnline = true;
      where.isActive = true;
    }

    // Build sort
    const orderBy = {};
    orderBy[sortBy] = sortOrder === 'desc' ? 'desc' : 'asc';

    const skip = (page - 1) * limit;

    const [readers, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy,
        take: parseInt(limit),
        skip,
        include: {
          readerSessions: {
            where: { status: 'ENDED' },
            select: {
              totalCost: true,
              readerEarnings: true,
              rating: true
            }
          }
        }
      }),
      prisma.user.count({ where })
    ]);

    // Calculate stats for each reader
    const readersWithStats = readers.map(reader => {
      const sessions = reader.readerSessions;
      const totalSessions = sessions.length;
      const totalEarnings = sessions.reduce((sum, s) => sum + (s.readerEarnings || 0), 0);
      const averageRating = sessions.length > 0 
        ? sessions.reduce((sum, s) => sum + (s.rating || 0), 0) / sessions.length 
        : 0;

      return {
        ...reader,
        readerSessions: undefined, // Remove from response
        stats: {
          totalSessions,
          totalEarnings,
          averageRating: Math.round(averageRating * 100) / 100
        }
      };
    });

    res.json({
      success: true,
      readers: readersWithStats,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalReaders: total,
        hasNext: page * limit < total,
        hasPrev: page > 1
      }
    });

  } catch (error) {
    console.error('Admin get readers error:', error);
    res.status(500).json({ 
      message: 'Failed to retrieve readers',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Create new reader account
router.post('/readers', validateUserRegistration, async (req, res) => {
  try {
    const { 
      email, 
      password, 
      name, 
      bio, 
      specialties = [], 
      videoRate = 3.99,
      audioRate = 2.99,
      chatRate = 1.99
    } = req.body;

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email }
    });

    if (existingUser) {
      return res.status(400).json({ message: 'User with this email already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create reader account
    const reader = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        role: 'READER',
        name: name || '',
        bio: bio || '',
        specialties: Array.isArray(specialties) ? specialties : [],
        videoRate: parseFloat(videoRate),
        audioRate: parseFloat(audioRate),
        chatRate: parseFloat(chatRate),
        isVerified: true, // Admin-created accounts are pre-verified
        isActive: true,
        isOnline: false
      }
    });

    // Remove password from response
    const { password: _, ...readerResponse } = reader;

    res.status(201).json({
      success: true,
      message: 'Reader account created successfully',
      reader: readerResponse
    });

  } catch (error) {
    console.error('Admin create reader error:', error);
    res.status(500).json({ 
      message: 'Failed to create reader account',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Update reader account
router.patch('/readers/:readerId', async (req, res) => {
  try {
    const { readerId } = req.params;
    const updates = req.body;

    const reader = await prisma.user.findUnique({
      where: { id: readerId, role: 'READER' }
    });

    if (!reader) {
      return res.status(404).json({ message: 'Reader not found' });
    }

    // Build update object
    const updateData = {};
    
    if (updates.isActive !== undefined) {
      updateData.isActive = updates.isActive;
    }
    
    if (updates.isVerified !== undefined) {
      updateData.isVerified = updates.isVerified;
    }
    
    if (updates.name !== undefined) {
      updateData.name = updates.name;
    }
    
    if (updates.bio !== undefined) {
      updateData.bio = updates.bio;
    }
    
    if (updates.specialties !== undefined) {
      updateData.specialties = updates.specialties;
    }
    
    if (updates.videoRate !== undefined) {
      updateData.videoRate = parseFloat(updates.videoRate);
    }
    
    if (updates.audioRate !== undefined) {
      updateData.audioRate = parseFloat(updates.audioRate);
    }
    
    if (updates.chatRate !== undefined) {
      updateData.chatRate = parseFloat(updates.chatRate);
    }

    const updatedReader = await prisma.user.update({
      where: { id: readerId },
      data: updateData
    });

    // Remove password from response
    const { password: _, ...readerResponse } = updatedReader;

    res.json({
      success: true,
      message: 'Reader updated successfully',
      reader: readerResponse
    });

  } catch (error) {
    console.error('Admin update reader error:', error);
    res.status(500).json({ 
      message: 'Failed to update reader',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get platform statistics
router.get('/stats', async (req, res) => {
  try {
    const { period = '30d' } = req.query;

    // Calculate date range
    let startDate = new Date();
    switch (period) {
      case '7d':
        startDate.setDate(startDate.getDate() - 7);
        break;
      case '30d':
        startDate.setDate(startDate.getDate() - 30);
        break;
      case '90d':
        startDate.setDate(startDate.getDate() - 90);
        break;
      case '1y':
        startDate.setFullYear(startDate.getFullYear() - 1);
        break;
      default:
        startDate.setDate(startDate.getDate() - 30);
    }

    // Get user statistics
    const [totalUsers, totalClients, totalReaders, activeReaders] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { role: 'CLIENT' } }),
      prisma.user.count({ where: { role: 'READER' } }),
      prisma.user.count({ where: { role: 'READER', isOnline: true } })
    ]);

    // Get session statistics
    const [totalSessions, periodSessions, sessionStats] = await Promise.all([
      prisma.session.count(),
      prisma.session.count({
        where: { createdAt: { gte: startDate } }
      }),
      prisma.session.aggregate({
        where: {
          status: 'ENDED',
          createdAt: { gte: startDate }
        },
        _sum: {
          totalCost: true,
          platformFee: true,
          readerEarnings: true,
          duration: true
        },
        _avg: {
          totalCost: true,
          duration: true,
          rating: true
        }
      })
    ]);

    // Get transaction statistics
    const transactionStats = await prisma.transaction.aggregate({
      where: {
        status: 'SUCCEEDED',
        createdAt: { gte: startDate }
      },
      _sum: { amount: true },
      _count: { id: true }
    });

    res.json({
      success: true,
      period,
      stats: {
        users: {
          total: totalUsers,
          clients: totalClients,
          readers: totalReaders,
          activeReaders
        },
        sessions: {
          total: totalSessions,
          period: periodSessions,
          totalRevenue: sessionStats._sum.totalCost || 0,
          platformRevenue: sessionStats._sum.platformFee || 0,
          readerEarnings: sessionStats._sum.readerEarnings || 0,
          totalMinutes: Math.floor((sessionStats._sum.duration || 0) / 60),
          averageSessionCost: sessionStats._avg.totalCost || 0,
          averageSessionDuration: Math.floor((sessionStats._avg.duration || 0) / 60),
          averageRating: sessionStats._avg.rating || 0
        },
        transactions: {
          total: transactionStats._count.id || 0,
          volume: transactionStats._sum.amount || 0
        }
      }
    });

  } catch (error) {
    console.error('Admin get stats error:', error);
    res.status(500).json({ 
      message: 'Failed to retrieve statistics',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

module.exports = router;