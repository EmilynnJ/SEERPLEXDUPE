const express = require('express');
const router = express.Router();
const { prisma, handlePrismaError } = require('../lib/prisma');
const auth = require('../middleware/auth');
const { body, param, query, validationResult } = require('express-validator');
const moment = require('moment-timezone');
const crypto = require('crypto');

// Validation middleware
const validateRequest = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array()
    });
  }
  next();
};

// Generate confirmation code
const generateConfirmationCode = () => {
  return crypto.randomBytes(10).toString('hex').toUpperCase();
};

// Check if time slot is available
const isTimeSlotAvailable = async (readerId, scheduledTime, duration, excludeBookingId = null) => {
  try {
    const startTime = new Date(scheduledTime);
    const endTime = new Date(startTime.getTime() + duration * 60000);

    // Check for overlapping bookings
    const conflictingBookings = await prisma.booking.findMany({
      where: {
        readerId,
        status: {
          in: ['PENDING', 'CONFIRMED']
        },
        scheduledTime: {
          lt: endTime
        },
        AND: {
          scheduledTime: {
            gte: new Date(startTime.getTime() - 60 * 60000) // 1 hour buffer
          }
        },
        ...(excludeBookingId && { id: { not: excludeBookingId } })
      }
    });

    // Check if any booking conflicts
    for (const booking of conflictingBookings) {
      const bookingEnd = new Date(booking.scheduledTime.getTime() + booking.duration * 60000);
      if (startTime < bookingEnd && endTime > booking.scheduledTime) {
        return false;
      }
    }

    return true;
  } catch (error) {
    console.error('Error checking time slot availability:', error);
    return false;
  }
};

// Check reader availability based on their schedule
const isReaderAvailable = async (readerId, scheduledTime, timezone) => {
  try {
    const reader = await prisma.user.findUnique({
      where: { id: readerId },
      select: { availability: true, isActive: true }
    });

    if (!reader || !reader.isActive) {
      return false;
    }

    // Convert scheduled time to reader's timezone
    const momentTime = moment.tz(scheduledTime, timezone);
    const dayOfWeek = momentTime.format('dddd').toLowerCase();
    const timeOfDay = momentTime.format('HH:mm');

    // Check if reader has availability set
    if (!reader.availability || !Array.isArray(reader.availability)) {
      return false;
    }

    // Find availability for the day
    const dayAvailability = reader.availability.find(avail => 
      avail.day === dayOfWeek
    );

    if (!dayAvailability) {
      return false;
    }

    // Check if time falls within available hours
    const startTime = dayAvailability.startTime;
    const endTime = dayAvailability.endTime;

    return timeOfDay >= startTime && timeOfDay <= endTime;
  } catch (error) {
    console.error('Error checking reader availability:', error);
    return false;
  }
};

// Calculate booking cost
const calculateBookingCost = async (readerId, sessionType, duration) => {
  try {
    const reader = await prisma.user.findUnique({
      where: { id: readerId },
      select: { 
        videoRate: true, 
        audioRate: true, 
        chatRate: true 
      }
    });

    if (!reader) {
      throw new Error('Reader not found');
    }

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
        throw new Error('Invalid session type');
    }

    const totalCost = (rate * duration) / 60; // Convert per-minute rate to total cost
    return { rate, totalCost };
  } catch (error) {
    throw error;
  }
};

// Send booking notification (placeholder for notification system)
const sendBookingNotification = async (type, booking, additionalData = {}) => {
  try {
    // This would integrate with the notification system
    console.log(`Booking notification: ${type}`, {
      bookingId: booking.id,
      clientId: booking.clientId,
      readerId: booking.readerId,
      ...additionalData
    });
    
    // TODO: Implement actual notification sending
    // - Email notifications
    // - Push notifications
    // - SMS notifications
    // - Real-time socket notifications
  } catch (error) {
    console.error('Error sending booking notification:', error);
  }
};

// GET /api/bookings - Get user's bookings
router.get('/', 
  auth,
  [
    query('status').optional().isIn(['PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW']),
    query('type').optional().isIn(['upcoming', 'past', 'all']).default('all'),
    query('page').optional().isInt({ min: 1 }).default(1),
    query('limit').optional().isInt({ min: 1, max: 50 }).default(10)
  ],
  validateRequest,
  async (req, res) => {
    try {
      const { status, type, page, limit } = req.query;
      const userId = req.user.id;
      const skip = (page - 1) * limit;

      let whereClause = {
        OR: [
          { clientId: userId },
          { readerId: userId }
        ]
      };

      // Filter by status
      if (status) {
        whereClause.status = status;
      }

      // Filter by time (upcoming/past)
      if (type === 'upcoming') {
        whereClause.scheduledTime = { gte: new Date() };
      } else if (type === 'past') {
        whereClause.scheduledTime = { lt: new Date() };
      }

      const [bookings, total] = await Promise.all([
        prisma.booking.findMany({
          where: whereClause,
          include: {
            client: {
              select: {
                id: true,
                name: true,
                email: true,
                avatar: true
              }
            },
            reader: {
              select: {
                id: true,
                name: true,
                email: true,
                avatar: true,
                specialties: true,
                rating: true
              }
            },
            session: {
              select: {
                id: true,
                status: true,
                rating: true,
                review: true
              }
            }
          },
          orderBy: { scheduledTime: 'desc' },
          skip: parseInt(skip),
          take: parseInt(limit)
        }),
        prisma.booking.count({ where: whereClause })
      ]);

      res.json({
        success: true,
        data: {
          bookings,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / limit)
          }
        }
      });
    } catch (error) {
      console.error('Error fetching bookings:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch bookings'
      });
    }
  }
);

// GET /api/bookings/:id - Get specific booking
router.get('/:id',
  auth,
  [param('id').isString().notEmpty()],
  validateRequest,
  async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.user.id;

      const booking = await prisma.booking.findFirst({
        where: {
          id,
          OR: [
            { clientId: userId },
            { readerId: userId }
          ]
        },
        include: {
          client: {
            select: {
              id: true,
              name: true,
              email: true,
              avatar: true
            }
          },
          reader: {
            select: {
              id: true,
              name: true,
              email: true,
              avatar: true,
              specialties: true,
              rating: true,
              totalReviews: true
            }
          },
          session: {
            select: {
              id: true,
              status: true,
              rating: true,
              review: true,
              startTime: true,
              endTime: true,
              duration: true
            }
          }
        }
      });

      if (!booking) {
        return res.status(404).json({
          success: false,
          message: 'Booking not found'
        });
      }

      res.json({
        success: true,
        data: booking
      });
    } catch (error) {
      console.error('Error fetching booking:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch booking'
      });
    }
  }
);

// POST /api/bookings - Create new booking
router.post('/',
  auth,
  [
    body('readerId').isString().notEmpty(),
    body('scheduledTime').isISO8601(),
    body('duration').isInt({ min: 15, max: 180 }),
    body('sessionType').isIn(['VIDEO', 'AUDIO', 'CHAT']),
    body('timezone').isString().notEmpty(),
    body('clientNotes').optional().isString().isLength({ max: 1000 }),
    body('specialRequests').optional().isString().isLength({ max: 500 })
  ],
  validateRequest,
  async (req, res) => {
    try {
      const {
        readerId,
        scheduledTime,
        duration,
        sessionType,
        timezone,
        clientNotes,
        specialRequests
      } = req.body;
      const clientId = req.user.id;

      // Validate that user is not booking with themselves
      if (clientId === readerId) {
        return res.status(400).json({
          success: false,
          message: 'Cannot book a session with yourself'
        });
      }

      // Check if reader exists and is active
      const reader = await prisma.user.findUnique({
        where: { id: readerId },
        select: { 
          id: true, 
          role: true, 
          isActive: true,
          videoRate: true,
          audioRate: true,
          chatRate: true
        }
      });

      if (!reader || reader.role !== 'READER' || !reader.isActive) {
        return res.status(400).json({
          success: false,
          message: 'Reader not found or inactive'
        });
      }

      // Validate scheduled time is in the future
      const scheduledDate = new Date(scheduledTime);
      const now = new Date();
      const minBookingTime = new Date(now.getTime() + 30 * 60000); // 30 minutes from now

      if (scheduledDate < minBookingTime) {
        return res.status(400).json({
          success: false,
          message: 'Booking must be at least 30 minutes in advance'
        });
      }

      // Check reader availability
      const isAvailable = await isReaderAvailable(readerId, scheduledTime, timezone);
      if (!isAvailable) {
        return res.status(400).json({
          success: false,
          message: 'Reader is not available at the requested time'
        });
      }

      // Check time slot availability
      const isSlotAvailable = await isTimeSlotAvailable(readerId, scheduledTime, duration);
      if (!isSlotAvailable) {
        return res.status(400).json({
          success: false,
          message: 'Time slot is not available'
        });
      }

      // Calculate cost
      const { rate, totalCost } = await calculateBookingCost(readerId, sessionType, duration);

      // Check client balance
      const client = await prisma.user.findUnique({
        where: { id: clientId },
        select: { balance: true }
      });

      if (client.balance < totalCost) {
        return res.status(400).json({
          success: false,
          message: 'Insufficient balance for this booking',
          data: {
            required: totalCost,
            available: client.balance
          }
        });
      }

      // Create booking
      const confirmationCode = generateConfirmationCode();
      
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
          confirmationCode,
          clientNotes,
          specialRequests,
          status: 'PENDING',
          remindersSent: []
        },
        include: {
          client: {
            select: {
              id: true,
              name: true,
              email: true,
              avatar: true
            }
          },
          reader: {
            select: {
              id: true,
              name: true,
              email: true,
              avatar: true,
              specialties: true
            }
          }
        }
      });

      // Send notifications
      await sendBookingNotification('booking_created', booking);

      res.status(201).json({
        success: true,
        message: 'Booking created successfully',
        data: booking
      });
    } catch (error) {
      console.error('Error creating booking:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to create booking'
      });
    }
  }
);

// PUT /api/bookings/:id - Update booking (reschedule)
router.put('/:id',
  auth,
  [
    param('id').isString().notEmpty(),
    body('scheduledTime').optional().isISO8601(),
    body('duration').optional().isInt({ min: 15, max: 180 }),
    body('timezone').optional().isString(),
    body('clientNotes').optional().isString().isLength({ max: 1000 }),
    body('readerNotes').optional().isString().isLength({ max: 1000 }),
    body('specialRequests').optional().isString().isLength({ max: 500 })
  ],
  validateRequest,
  async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.user.id;
      const updateData = req.body;

      // Find existing booking
      const existingBooking = await prisma.booking.findFirst({
        where: {
          id,
          OR: [
            { clientId: userId },
            { readerId: userId }
          ],
          status: { in: ['PENDING', 'CONFIRMED'] }
        }
      });

      if (!existingBooking) {
        return res.status(404).json({
          success: false,
          message: 'Booking not found or cannot be modified'
        });
      }

      // Check if rescheduling
      if (updateData.scheduledTime) {
        const newScheduledTime = new Date(updateData.scheduledTime);
        const now = new Date();
        const minBookingTime = new Date(now.getTime() + 30 * 60000);

        if (newScheduledTime < minBookingTime) {
          return res.status(400).json({
            success: false,
            message: 'Rescheduled time must be at least 30 minutes in advance'
          });
        }

        // Check availability for new time
        const duration = updateData.duration || existingBooking.duration;
        const timezone = updateData.timezone || existingBooking.timezone;

        const isAvailable = await isReaderAvailable(
          existingBooking.readerId, 
          newScheduledTime, 
          timezone
        );
        
        if (!isAvailable) {
          return res.status(400).json({
            success: false,
            message: 'Reader is not available at the new requested time'
          });
        }

        const isSlotAvailable = await isTimeSlotAvailable(
          existingBooking.readerId, 
          newScheduledTime, 
          duration,
          id
        );
        
        if (!isSlotAvailable) {
          return res.status(400).json({
            success: false,
            message: 'New time slot is not available'
          });
        }

        // Recalculate cost if duration changed
        if (updateData.duration && updateData.duration !== existingBooking.duration) {
          const { rate, totalCost } = await calculateBookingCost(
            existingBooking.readerId, 
            existingBooking.sessionType, 
            updateData.duration
          );
          updateData.rate = rate;
          updateData.totalCost = totalCost;
        }

        updateData.rescheduledFrom = existingBooking.scheduledTime;
      }

      // Determine who can update what
      const isClient = existingBooking.clientId === userId;
      const isReader = existingBooking.readerId === userId;

      // Restrict updates based on user role
      if (isClient) {
        // Clients can update: scheduledTime, duration, timezone, clientNotes, specialRequests
        delete updateData.readerNotes;
      } else if (isReader) {
        // Readers can update: readerNotes only (and confirm/decline via separate endpoints)
        const allowedFields = ['readerNotes'];
        Object.keys(updateData).forEach(key => {
          if (!allowedFields.includes(key)) {
            delete updateData[key];
          }
        });
      }

      // Update booking
      const updatedBooking = await prisma.booking.update({
        where: { id },
        data: {
          ...updateData,
          updatedAt: new Date()
        },
        include: {
          client: {
            select: {
              id: true,
              name: true,
              email: true,
              avatar: true
            }
          },
          reader: {
            select: {
              id: true,
              name: true,
              email: true,
              avatar: true,
              specialties: true
            }
          }
        }
      });

      // Send notifications if rescheduled
      if (updateData.scheduledTime) {
        await sendBookingNotification('booking_rescheduled', updatedBooking, {
          previousTime: existingBooking.scheduledTime
        });
      }

      res.json({
        success: true,
        message: 'Booking updated successfully',
        data: updatedBooking
      });
    } catch (error) {
      console.error('Error updating booking:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to update booking'
      });
    }
  }
);

// POST /api/bookings/:id/confirm - Reader confirms booking
router.post('/:id/confirm',
  auth,
  [param('id').isString().notEmpty()],
  validateRequest,
  async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.user.id;

      const booking = await prisma.booking.findFirst({
        where: {
          id,
          readerId: userId,
          status: 'PENDING'
        }
      });

      if (!booking) {
        return res.status(404).json({
          success: false,
          message: 'Booking not found or already processed'
        });
      }

      // Update booking status
      const confirmedBooking = await prisma.booking.update({
        where: { id },
        data: { 
          status: 'CONFIRMED',
          updatedAt: new Date()
        },
        include: {
          client: {
            select: {
              id: true,
              name: true,
              email: true,
              avatar: true
            }
          },
          reader: {
            select: {
              id: true,
              name: true,
              email: true,
              avatar: true,
              specialties: true
            }
          }
        }
      });

      // Send confirmation notifications
      await sendBookingNotification('booking_confirmed', confirmedBooking);

      res.json({
        success: true,
        message: 'Booking confirmed successfully',
        data: confirmedBooking
      });
    } catch (error) {
      console.error('Error confirming booking:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to confirm booking'
      });
    }
  }
);

// POST /api/bookings/:id/cancel - Cancel booking
router.post('/:id/cancel',
  auth,
  [
    param('id').isString().notEmpty(),
    body('reason').optional().isString().isLength({ max: 500 })
  ],
  validateRequest,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { reason } = req.body;
      const userId = req.user.id;

      const booking = await prisma.booking.findFirst({
        where: {
          id,
          OR: [
            { clientId: userId },
            { readerId: userId }
          ],
          status: { in: ['PENDING', 'CONFIRMED'] }
        }
      });

      if (!booking) {
        return res.status(404).json({
          success: false,
          message: 'Booking not found or cannot be cancelled'
        });
      }

      // Check cancellation policy (24 hours before scheduled time)
      const scheduledTime = new Date(booking.scheduledTime);
      const now = new Date();
      const timeDiff = scheduledTime.getTime() - now.getTime();
      const hoursUntilBooking = timeDiff / (1000 * 60 * 60);

      let refundAmount = 0;
      if (hoursUntilBooking >= 24) {
        refundAmount = booking.totalCost; // Full refund
      } else if (hoursUntilBooking >= 2) {
        refundAmount = booking.totalCost * 0.5; // 50% refund
      }
      // No refund if less than 2 hours

      // Update booking
      const cancelledBooking = await prisma.booking.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledBy: userId,
          cancellationReason: reason,
          updatedAt: new Date()
        },
        include: {
          client: {
            select: {
              id: true,
              name: true,
              email: true,
              avatar: true
            }
          },
          reader: {
            select: {
              id: true,
              name: true,
              email: true,
              avatar: true,
              specialties: true
            }
          }
        }
      });

      // Process refund if applicable
      if (refundAmount > 0) {
        await prisma.user.update({
          where: { id: booking.clientId },
          data: {
            balance: {
              increment: refundAmount
            }
          }
        });

        // Create refund transaction
        await prisma.transaction.create({
          data: {
            userId: booking.clientId,
            type: 'REFUND',
            amount: refundAmount,
            status: 'SUCCEEDED',
            description: `Refund for cancelled booking ${booking.confirmationCode}`,
            metadata: {
              bookingId: booking.id,
              originalAmount: booking.totalCost,
              refundPercentage: (refundAmount / booking.totalCost) * 100
            }
          }
        });
      }

      // Send cancellation notifications
      await sendBookingNotification('booking_cancelled', cancelledBooking, {
        cancelledBy: userId,
        refundAmount,
        reason
      });

      res.json({
        success: true,
        message: 'Booking cancelled successfully',
        data: {
          booking: cancelledBooking,
          refundAmount
        }
      });
    } catch (error) {
      console.error('Error cancelling booking:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to cancel booking'
      });
    }
  }
);

// GET /api/bookings/reader/:readerId/availability - Get reader availability
router.get('/reader/:readerId/availability',
  auth,
  [
    param('readerId').isString().notEmpty(),
    query('date').optional().isISO8601(),
    query('timezone').optional().isString().default('UTC'),
    query('days').optional().isInt({ min: 1, max: 30 }).default(7)
  ],
  validateRequest,
  async (req, res) => {
    try {
      const { readerId } = req.params;
      const { date, timezone, days } = req.query;

      // Get reader info
      const reader = await prisma.user.findUnique({
        where: { id: readerId },
        select: {
          id: true,
          name: true,
          isActive: true,
          availability: true,
          videoRate: true,
          audioRate: true,
          chatRate: true
        }
      });

      if (!reader || !reader.isActive) {
        return res.status(404).json({
          success: false,
          message: 'Reader not found or inactive'
        });
      }

      // Calculate date range
      const startDate = date ? moment.tz(date, timezone) : moment.tz(timezone);
      const endDate = moment(startDate).add(days, 'days');

      // Get existing bookings in the date range
      const existingBookings = await prisma.booking.findMany({
        where: {
          readerId,
          status: { in: ['PENDING', 'CONFIRMED'] },
          scheduledTime: {
            gte: startDate.toDate(),
            lt: endDate.toDate()
          }
        },
        select: {
          scheduledTime: true,
          duration: true
        }
      });

      // Generate availability slots
      const availabilitySlots = [];
      const current = moment(startDate);

      while (current.isBefore(endDate)) {
        const dayOfWeek = current.format('dddd').toLowerCase();
        const dayAvailability = reader.availability?.find(avail => 
          avail.day === dayOfWeek
        );

        if (dayAvailability) {
          const dayStart = moment(current).startOf('day');
          const slotStart = dayStart.clone().add(moment.duration(dayAvailability.startTime));
          const slotEnd = dayStart.clone().add(moment.duration(dayAvailability.endTime));

          // Generate 30-minute slots
          const currentSlot = slotStart.clone();
          while (currentSlot.isBefore(slotEnd)) {
            const slotEndTime = currentSlot.clone().add(30, 'minutes');
            
            // Check if slot is in the future
            if (currentSlot.isAfter(moment())) {
              // Check if slot conflicts with existing bookings
              const hasConflict = existingBookings.some(booking => {
                const bookingStart = moment(booking.scheduledTime);
                const bookingEnd = bookingStart.clone().add(booking.duration, 'minutes');
                return currentSlot.isBefore(bookingEnd) && slotEndTime.isAfter(bookingStart);
              });

              if (!hasConflict) {
                availabilitySlots.push({
                  startTime: currentSlot.toISOString(),
                  endTime: slotEndTime.toISOString(),
                  available: true
                });
              }
            }

            currentSlot.add(30, 'minutes');
          }
        }

        current.add(1, 'day');
      }

      res.json({
        success: true,
        data: {
          reader: {
            id: reader.id,
            name: reader.name,
            rates: {
              video: reader.videoRate,
              audio: reader.audioRate,
              chat: reader.chatRate
            }
          },
          availability: availabilitySlots,
          timezone,
          dateRange: {
            start: startDate.toISOString(),
            end: endDate.toISOString()
          }
        }
      });
    } catch (error) {
      console.error('Error fetching reader availability:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch reader availability'
      });
    }
  }
);

// GET /api/bookings/upcoming - Get upcoming bookings (next 24 hours)
router.get('/upcoming',
  auth,
  async (req, res) => {
    try {
      const userId = req.user.id;
      const now = new Date();
      const next24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      const upcomingBookings = await prisma.booking.findMany({
        where: {
          OR: [
            { clientId: userId },
            { readerId: userId }
          ],
          status: 'CONFIRMED',
          scheduledTime: {
            gte: now,
            lte: next24Hours
          }
        },
        include: {
          client: {
            select: {
              id: true,
              name: true,
              avatar: true
            }
          },
          reader: {
            select: {
              id: true,
              name: true,
              avatar: true,
              specialties: true
            }
          }
        },
        orderBy: { scheduledTime: 'asc' }
      });

      res.json({
        success: true,
        data: upcomingBookings
      });
    } catch (error) {
      console.error('Error fetching upcoming bookings:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch upcoming bookings'
      });
    }
  }
);

module.exports = router;