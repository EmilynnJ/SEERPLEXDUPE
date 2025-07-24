const express = require('express');
const router = express.Router();
const { prisma, handlePrismaError } = require('../lib/prisma');
const { authMiddleware, requireClient, requireReader } = require('../middleware/auth');
const { validateBooking } = require('../middleware/validation');
const { v4: uuidv4 } = require('uuid');

// Create a new booking (clients only)
router.post('/', authMiddleware, requireClient, validateBooking, async (req, res) => {
  try {
    const { readerId, scheduledTime, duration, sessionType, timezone, clientNotes } = req.body;
    const clientId = req.user.userId;

    // Validate reader exists and is active
    const reader = await prisma.user.findUnique({
      where: { id: readerId, role: 'READER', isActive: true }
    });

    if (!reader) {
      return res.status(404).json({ message: 'Reader not found or unavailable' });
    }

    // Get client and check balance
    const client = await prisma.user.findUnique({
      where: { id: clientId }
    });

    // Calculate cost
    let rate;
    switch (sessionType) {
      case 'VIDEO':
        rate = reader.videoRate;
        break;
      case 'AUDIO':
        rate = reader.audioRate;
        break;
      case 'CHAT':
        rate = reader.chatRate;
        break;
      default:
        return res.status(400).json({ message: 'Invalid session type' });
    }

    const totalCost = rate * duration;

    // Check if client has sufficient balance
    if (client.balance < totalCost) {
      return res.status(400).json({ 
        message: 'Insufficient balance for this booking',
        requiredAmount: totalCost,
        currentBalance: client.balance
      });
    }

    // Check for scheduling conflicts
    const scheduledDate = new Date(scheduledTime);
    const endTime = new Date(scheduledDate.getTime() + duration * 60000);

    const conflictingBookings = await prisma.booking.findMany({
      where: {
        readerId,
        status: { in: ['PENDING', 'CONFIRMED'] },
        scheduledTime: {
          lt: endTime
        },
        AND: {
          scheduledTime: {
            gte: new Date(scheduledDate.getTime() - duration * 60000)
          }
        }
      }
    });

    if (conflictingBookings.length > 0) {
      return res.status(400).json({ 
        message: 'Reader is not available at the requested time',
        conflictingBookings: conflictingBookings.map(b => ({
          scheduledTime: b.scheduledTime,
          duration: b.duration
        }))
      });
    }

    // Generate confirmation code
    const confirmationCode = uuidv4().substring(0, 8).toUpperCase();

    // Create booking
    const booking = await prisma.booking.create({
      data: {
        clientId,
        readerId,
        scheduledTime: scheduledDate,
        duration,
        sessionType,
        timezone,
        rate,
        totalCost,
        clientNotes: clientNotes || '',
        confirmationCode,
        status: 'PENDING'
      },
      include: {
        client: {
          select: { id: true, name: true, email: true, avatar: true }
        },
        reader: {
          select: { id: true, name: true, email: true, avatar: true }
        }
      }
    });

    res.status(201).json({
      success: true,
      message: 'Booking created successfully',
      booking: {
        id: booking.id,
        confirmationCode: booking.confirmationCode,
        scheduledTime: booking.scheduledTime,
        duration: booking.duration,
        sessionType: booking.sessionType,
        totalCost: booking.totalCost,
        status: booking.status,
        reader: booking.reader,
        client: booking.client
      }
    });

  } catch (error) {
    console.error('Create booking error:', error);
    res.status(500).json({ 
      message: 'Failed to create booking',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get user's bookings
router.get('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { 
      page = 1, 
      limit = 20, 
      status,
      upcoming = false
    } = req.query;

    const where = {
      OR: [
        { clientId: userId },
        { readerId: userId }
      ]
    };

    if (status) {
      where.status = status.toUpperCase();
    }

    if (upcoming === 'true') {
      where.scheduledTime = { gte: new Date() };
      where.status = { in: ['PENDING', 'CONFIRMED'] };
    }

    const skip = (page - 1) * limit;

    const [bookings, total] = await Promise.all([
      prisma.booking.findMany({
        where,
        include: {
          client: {
            select: { id: true, name: true, email: true, avatar: true }
          },
          reader: {
            select: { id: true, name: true, email: true, avatar: true }
          }
        },
        orderBy: { scheduledTime: 'desc' },
        take: parseInt(limit),
        skip
      }),
      prisma.booking.count({ where })
    ]);

    res.json({
      success: true,
      bookings: bookings.map(booking => ({
        ...booking,
        isClient: booking.clientId === userId
      })),
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalBookings: total,
        hasNext: page * limit < total,
        hasPrev: page > 1
      }
    });

  } catch (error) {
    console.error('Get bookings error:', error);
    res.status(500).json({ 
      message: 'Failed to retrieve bookings',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Confirm booking (readers only)
router.patch('/:bookingId/confirm', authMiddleware, requireReader, validateBooking, async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { readerNotes } = req.body;

    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, status: 'PENDING' }
    });

    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    const confirmedBooking = await prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: 'CONFIRMED',
        updatedAt: new Date(),
        readerNotes
      },
      include: {
        client: {
          select: { id: true, name: true, email: true, avatar: true }
        },
        reader: {
          select: { id: true, name: true, email: true, avatar: true }
        }
      }
    });

    res.json({
      success: true,
      message: 'Booking confirmed successfully',
      booking: confirmedBooking
    });

  } catch (error) {
    console.error('Confirm booking error:', error);
    res.status(500).json({ 
      message: 'Failed to confirm booking',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Cancel booking (readers only)
router.patch('/:bookingId/cancel', authMiddleware, requireReader, validateBooking, async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { reason } = req.body;

    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, status: { in: ['PENDING', 'CONFIRMED'] } }
    });

    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    const cancelledBooking = await prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledBy: req.user.userId,
        cancellationReason: reason,
        updatedAt: new Date()
      },
      include: {
        client: {
          select: { id: true, name: true, email: true, avatar: true }
        },
        reader: {
          select: { id: true, name: true, email: true, avatar: true }
        }
      }
    });

    res.json({
      success: true,
      message: 'Booking cancelled successfully',
      booking: cancelledBooking
    });

  } catch (error) {
    console.error('Cancel booking error:', error);
    res.status(500).json({ 
      message: 'Failed to cancel booking',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

module.exports = router;