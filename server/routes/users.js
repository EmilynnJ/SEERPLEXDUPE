const express = require('express');
const { prisma } = require('../lib/prisma');
const { authMiddleware, requireReader, requireReaderOrAdmin, optionalAuth } = require('../middleware/auth');
const { validateProfileUpdate, validateReaderRates } = require('../middleware/validation');

const router = express.Router();

// Get all readers (public endpoint with optional auth for favorites)
router.get('/readers', optionalAuth, async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20, 
      specialty, 
      minRating, 
      maxRate, 
      isOnline,
      sortBy = 'rating' 
    } = req.query;

    // Fetch readers from database
    const allReaders = await prisma.user.findMany({
      where: {
        role: 'reader',
        isActive: true
      },
      select: {
        id: true,
        profile: true,
        readerSettings: true,
        createdAt: true
      }
    });

    // In-memory filtering
    let filtered = allReaders;
    if (specialty) {
      filtered = filtered.filter(r => Array.isArray(r.profile.specialties) && r.profile.specialties.includes(specialty));
    }
    if (minRating) {
      const min = parseFloat(minRating);
      filtered = filtered.filter(r => (r.profile.rating || 0) >= min);
    }
    if (isOnline === 'true') {
      filtered = filtered.filter(r => r.readerSettings.isOnline === true);
    }
    if (maxRate) {
      const max = parseFloat(maxRate);
      filtered = filtered.filter(r => (r.readerSettings.rates?.video || 0) <= max);
    }

    // Sort in-memory
    const sorted = filtered.sort((a, b) => {
      switch (sortBy) {
        case 'rating':
          if ((b.profile.rating || 0) !== (a.profile.rating || 0)) {
            return (b.profile.rating || 0) - (a.profile.rating || 0);
          }
          return (b.profile.totalReviews || 0) - (a.profile.totalReviews || 0);
        case 'price_low':
          return (a.readerSettings.rates?.video || 0) - (b.readerSettings.rates?.video || 0);
        case 'price_high':
          return (b.readerSettings.rates?.video || 0) - (a.readerSettings.rates?.video || 0);
        case 'newest':
          return b.createdAt - a.createdAt;
        case 'online':
          if ((b.readerSettings.isOnline ? 1 : 0) !== (a.readerSettings.isOnline ? 1 : 0)) {
            return (b.readerSettings.isOnline ? 1 : 0) - (a.readerSettings.isOnline ? 1 : 0);
          }
          return (b.profile.rating || 0) - (a.profile.rating || 0);
        default:
          return (b.profile.rating || 0) - (a.profile.rating || 0);
      }
    });

    // Pagination
    const total = sorted.length;
    const currentPage = parseInt(page, 10);
    const pageSize = parseInt(limit, 10);
    const start = (currentPage - 1) * pageSize;
    const pagedReaders = sorted.slice(start, start + pageSize);

    // Format reader data for public consumption
    const formattedReaders = pagedReaders.map(reader => ({
      id: reader.id,
      name: reader.profile.name || 'Anonymous Reader',
      avatar: reader.profile.avatar,
      bio: reader.profile.bio,
      specialties: reader.profile.specialties || [],
      rating: reader.profile.rating || 0,
      totalReviews: reader.profile.totalReviews || 0,
      isOnline: reader.readerSettings.isOnline || false,
      rates: reader.readerSettings.rates,
      memberSince: reader.createdAt
    }));

    res.json({
      success: true,
      readers: formattedReaders,
      pagination: {
        currentPage,
        totalPages: Math.ceil(total / pageSize),
        totalReaders: total,
        hasNext: currentPage * pageSize < total,
        hasPrev: currentPage > 1
      }
    });

  } catch (error) {
    console.error('Get readers error:', error);
    res.status(500).json({ 
      message: 'Server error fetching readers',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get specific reader profile
router.get('/readers/:readerId', optionalAuth, async (req, res) => {
  try {
    const { readerId } = req.params;

    const reader = await prisma.user.findUnique({
      where: { id: readerId },
      select: {
        id: true,
        profile: true,
        readerSettings: true,
        createdAt: true
      }
    });

    if (!reader || reader.profile.role !== 'reader') {
      return res.status(404).json({ message: 'Reader not found' });
    }

    // Get recent reviews from sessions
    const recentSessions = await prisma.session.findMany({
      where: {
        readerId,
        status: 'ended',
        rating: { not: null },
        review: { not: '' }
      },
      include: {
        client: {
          select: { profile: true }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: 5
    });

    const recentReviews = recentSessions.map(session => ({
      rating: session.rating,
      review: session.review,
      clientName: session.client?.profile?.name || 'Anonymous',
      date: session.createdAt
    }));

    const readerProfile = {
      id: reader.id,
      name: reader.profile.name || 'Anonymous Reader',
      avatar: reader.profile.avatar,
      bio: reader.profile.bio,
      specialties: reader.profile.specialties || [],
      rating: reader.profile.rating || 0,
      totalReviews: reader.profile.totalReviews || 0,
      isOnline: reader.readerSettings.isOnline || false,
      rates: reader.readerSettings.rates,
      memberSince: reader.createdAt,
      recentReviews
    };

    res.json({
      success: true,
      reader: readerProfile
    });

  } catch (error) {
    console.error('Get reader profile error:', error);
    res.status(500).json({ 
      message: 'Server error fetching reader profile',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Update user profile
router.patch('/profile', authMiddleware, validateProfileUpdate, async (req, res) => {
  try {
    const userId = req.user.userId;
    const updates = req.body;

    const existing = await prisma.user.findUnique({
      where: { id: userId },
      select: { profile: true, email: true, role: true }
    });
    if (!existing) {
      return res.status(404).json({ message: 'User not found' });
    }

    const newProfile = { ...existing.profile };
    if (updates.name !== undefined) newProfile.name = updates.name;
    if (updates.bio !== undefined) newProfile.bio = updates.bio;
    if (updates.specialties !== undefined) newProfile.specialties = updates.specialties;
    if (updates.avatar !== undefined) newProfile.avatar = updates.avatar;

    const user = await prisma.user.update({
      where: { id: userId },
      data: { profile: newProfile },
      select: {
        id: true,
        email: true,
        role: true,
        profile: true,
        readerSettings: true
      }
    });

    res.json({
      success: true,
      message: 'Profile updated successfully',
      user
    });

  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ 
      message: 'Server error updating profile',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Update reader rates (readers only)
router.patch('/rates', authMiddleware, requireReader, validateReaderRates, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { rates } = req.body;

    const existing = await prisma.user.findUnique({
      where: { id: userId },
      select: { readerSettings: true }
    });
    if (!existing) {
      return res.status(404).json({ message: 'User not found' });
    }

    const newSettings = { ...existing.readerSettings, rates };

    const user = await prisma.user.update({
      where: { id: userId },
      data: { readerSettings: newSettings },
      select: { readerSettings: true }
    });

    res.json({
      success: true,
      message: 'Rates updated successfully',
      rates: user.readerSettings.rates
    });

  } catch (error) {
    console.error('Update rates error:', error);
    res.status(500).json({ 
      message: 'Server error updating rates',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Toggle online status (readers only)
router.patch('/status', authMiddleware, requireReader, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { isOnline } = req.body;

    if (typeof isOnline !== 'boolean') {
      return res.status(400).json({ message: 'isOnline must be a boolean value' });
    }

    const existing = await prisma.user.findUnique({
      where: { id: userId },
      select: { readerSettings: true }
    });
    if (!existing) {
      return res.status(404).json({ message: 'User not found' });
    }

    const newSettings = { ...existing.readerSettings, isOnline };

    const user = await prisma.user.update({
      where: { id: userId },
      data: { 
        readerSettings: newSettings,
        lastSeen: new Date()
      },
      select: { readerSettings: true }
    });

    res.json({
      success: true,
      message: `Status updated to ${isOnline ? 'online' : 'offline'}`,
      isOnline: user.readerSettings.isOnline
    });

  } catch (error) {
    console.error('Update status error:', error);
    res.status(500).json({ 
      message: 'Server error updating status',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get user earnings (readers only)
router.get('/earnings', authMiddleware, requireReader, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { period = '30d' } = req.query;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { earnings: true }
    });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Calculate period-specific earnings
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

    const sessions = await prisma.session.findMany({
      where: {
        readerId: userId,
        status: 'ended',
        endTime: { gte: startDate }
      },
      select: { readerEarnings: true, endTime: true }
    });
    const periodEarnings = sessions.reduce((sum, s) => sum + (s.readerEarnings || 0), 0);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todaySessions = await prisma.session.findMany({
      where: {
        readerId: userId,
        status: 'ended',
        endTime: { gte: todayStart }
      },
      select: { readerEarnings: true }
    });
    const todayEarnings = todaySessions.reduce((sum, s) => sum + (s.readerEarnings || 0), 0);

    res.json({
      success: true,
      earnings: {
        total: user.earnings.total,
        pending: user.earnings.pending,
        paid: user.earnings.paid,
        today: todayEarnings,
        period: periodEarnings,
        lastPayout: user.earnings.lastPayout
      }
    });

  } catch (error) {
    console.error('Get earnings error:', error);
    res.status(500).json({ 
      message: 'Server error fetching earnings',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get user statistics
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const userRole = req.user.role;

    let stats = {};

    if (userRole === 'client') {
      const sessions = await prisma.session.findMany({
        where: { clientId: userId },
        select: { totalCost: true, duration: true }
      });
      const totalSpent = sessions.reduce((sum, s) => sum + (s.totalCost || 0), 0);
      const totalSessions = sessions.length;
      const totalMinutes = sessions.reduce((sum, s) => sum + (s.duration || 0), 0) / 60;

      stats = {
        totalSessions,
        totalSpent,
        totalMinutes: Math.round(totalMinutes),
        averageSessionLength: totalSessions > 0 ? Math.round(totalMinutes / totalSessions) : 0,
        favoriteReaders: 0 // TODO: Implement favorites
      };

    } else if (userRole === 'reader') {
      const sessions = await prisma.session.findMany({
        where: { readerId: userId, status: 'ended' },
        select: { readerEarnings: true, duration: true, rating: true }
      });
      const totalEarnings = sessions.reduce((sum, s) => sum + (s.readerEarnings || 0), 0);
      const totalSessions = sessions.length;
      const totalMinutes = sessions.reduce((sum, s) => sum + (s.duration || 0), 0) / 60;
      const ratedSessions = sessions.filter(s => s.rating != null);
      const averageRating = ratedSessions.length > 0
        ? ratedSessions.reduce((sum, s) => sum + (s.rating || 0), 0) / ratedSessions.length
        : 0;

      stats = {
        totalSessions,
        totalEarnings,
        totalMinutes: Math.round(totalMinutes),
        averageSessionLength: totalSessions > 0 ? Math.round(totalMinutes / totalSessions) : 0,
        averageRating: Math.round(averageRating * 10) / 10,
        totalReviews: ratedSessions.length
      };
    }

    res.json({
      success: true,
      stats
    });

  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ 
      message: 'Server error fetching statistics',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

module.exports = router;