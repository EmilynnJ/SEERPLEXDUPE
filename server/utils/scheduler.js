const { prisma, handlePrismaError } = require('../lib/prisma');
const moment = require('moment-timezone');
const { RRule, RRuleSet, rrulestr } = require('rrule');

/**
 * Scheduling utility for managing reader availability, booking conflicts,
 * timezone conversions, and automated reminders
 */
class SchedulingManager {
  constructor() {
    this.defaultTimezone = 'UTC';
    this.businessHours = {
      start: '09:00',
      end: '21:00'
    };
    this.minBookingAdvance = 30; // minutes
    this.maxBookingAdvance = 30; // days
  }

  /**
   * Create or update reader availability
   */
  async setReaderAvailability(readerId, availabilityData) {
    try {
      const {
        timezone,
        recurringPattern,
        specificDates,
        blackoutDates,
        businessHours
      } = availabilityData;

      // Validate timezone
      if (!moment.tz.zone(timezone)) {
        throw new Error(`Invalid timezone: ${timezone}`);
      }

      // Convert recurring patterns to UTC
      const utcRecurringPattern = this.convertRecurringPatternToUTC(
        recurringPattern,
        timezone
      );

      // Convert specific dates to UTC
      const utcSpecificDates = this.convertDatesToUTC(specificDates, timezone);

      // Convert blackout dates to UTC
      const utcBlackoutDates = this.convertDatesToUTC(blackoutDates, timezone);

      const availability = await prisma.availability.upsert({
        where: { readerId },
        update: {
          timezone,
          recurringPattern: utcRecurringPattern,
          specificDates: utcSpecificDates,
          blackoutDates: utcBlackoutDates,
          businessHours: businessHours || this.businessHours,
          updatedAt: new Date()
        },
        create: {
          readerId,
          timezone,
          recurringPattern: utcRecurringPattern,
          specificDates: utcSpecificDates,
          blackoutDates: utcBlackoutDates,
          businessHours: businessHours || this.businessHours
        }
      });

      return availability;
    } catch (error) {
      throw handlePrismaError(error);
    }
  }

  /**
   * Get reader availability for a date range
   */
  async getReaderAvailability(readerId, startDate, endDate, userTimezone = 'UTC') {
    try {
      const availability = await prisma.availability.findUnique({
        where: { readerId }
      });

      if (!availability) {
        return { availableSlots: [], timezone: userTimezone };
      }

      // Generate available slots based on recurring patterns
      const recurringSlots = this.generateRecurringSlots(
        availability.recurringPattern,
        startDate,
        endDate,
        availability.timezone
      );

      // Add specific date slots
      const specificSlots = this.generateSpecificDateSlots(
        availability.specificDates,
        startDate,
        endDate
      );

      // Combine all slots
      let allSlots = [...recurringSlots, ...specificSlots];

      // Remove blackout dates
      allSlots = this.removeBlackoutDates(allSlots, availability.blackoutDates);

      // Remove already booked slots
      const bookedSlots = await this.getBookedSlots(readerId, startDate, endDate);
      allSlots = this.removeBookedSlots(allSlots, bookedSlots);

      // Convert to user's timezone
      const userSlots = allSlots.map(slot => ({
        ...slot,
        startTime: moment.utc(slot.startTime).tz(userTimezone).format(),
        endTime: moment.utc(slot.endTime).tz(userTimezone).format()
      }));

      return {
        availableSlots: userSlots,
        timezone: userTimezone,
        readerTimezone: availability.timezone
      };
    } catch (error) {
      throw handlePrismaError(error);
    }
  }

  /**
   * Create a booking
   */
  async createBooking(bookingData) {
    try {
      const {
        readerId,
        clientId,
        startTime,
        endTime,
        timezone,
        serviceType,
        notes
      } = bookingData;

      // Convert times to UTC
      const utcStartTime = moment.tz(startTime, timezone).utc().toDate();
      const utcEndTime = moment.tz(endTime, timezone).utc().toDate();

      // Validate booking time
      await this.validateBookingTime(readerId, utcStartTime, utcEndTime);

      // Check for conflicts
      const hasConflict = await this.checkBookingConflicts(
        readerId,
        utcStartTime,
        utcEndTime
      );

      if (hasConflict) {
        throw new Error('Booking conflicts with existing appointment');
      }

      // Create booking
      const booking = await prisma.booking.create({
        data: {
          readerId,
          clientId,
          startTime: utcStartTime,
          endTime: utcEndTime,
          timezone,
          serviceType,
          notes,
          status: 'confirmed'
        },
        include: {
          reader: true,
          client: true
        }
      });

      // Schedule reminders
      await this.scheduleReminders(booking);

      return booking;
    } catch (error) {
      throw handlePrismaError(error);
    }
  }

  /**
   * Update a booking
   */
  async updateBooking(bookingId, updateData) {
    try {
      const existingBooking = await prisma.booking.findUnique({
        where: { id: bookingId }
      });

      if (!existingBooking) {
        throw new Error('Booking not found');
      }

      // If time is being changed, validate new time
      if (updateData.startTime || updateData.endTime) {
        const newStartTime = updateData.startTime 
          ? moment.tz(updateData.startTime, updateData.timezone || existingBooking.timezone).utc().toDate()
          : existingBooking.startTime;
        
        const newEndTime = updateData.endTime
          ? moment.tz(updateData.endTime, updateData.timezone || existingBooking.timezone).utc().toDate()
          : existingBooking.endTime;

        await this.validateBookingTime(existingBooking.readerId, newStartTime, newEndTime);

        // Check for conflicts (excluding current booking)
        const hasConflict = await this.checkBookingConflicts(
          existingBooking.readerId,
          newStartTime,
          newEndTime,
          bookingId
        );

        if (hasConflict) {
          throw new Error('Updated booking conflicts with existing appointment');
        }

        updateData.startTime = newStartTime;
        updateData.endTime = newEndTime;
      }

      const updatedBooking = await prisma.booking.update({
        where: { id: bookingId },
        data: {
          ...updateData,
          updatedAt: new Date()
        },
        include: {
          reader: true,
          client: true
        }
      });

      // Reschedule reminders if time changed
      if (updateData.startTime || updateData.endTime) {
        await this.rescheduleReminders(updatedBooking);
      }

      return updatedBooking;
    } catch (error) {
      throw handlePrismaError(error);
    }
  }

  /**
   * Cancel a booking
   */
  async cancelBooking(bookingId, cancelledBy, reason = '') {
    try {
      const booking = await prisma.booking.update({
        where: { id: bookingId },
        data: {
          status: 'cancelled',
          cancelledBy,
          cancellationReason: reason,
          cancelledAt: new Date()
        },
        include: {
          reader: true,
          client: true
        }
      });

      // Cancel reminders
      await this.cancelReminders(bookingId);

      return booking;
    } catch (error) {
      throw handlePrismaError(error);
    }
  }

  /**
   * Get bookings for a user
   */
  async getUserBookings(userId, filters = {}) {
    try {
      const {
        startDate,
        endDate,
        status,
        timezone = 'UTC',
        limit = 20,
        offset = 0
      } = filters;

      const where = {
        OR: [
          { readerId: userId },
          { clientId: userId }
        ]
      };

      if (startDate && endDate) {
        where.startTime = {
          gte: moment.tz(startDate, timezone).utc().toDate(),
          lte: moment.tz(endDate, timezone).utc().toDate()
        };
      }

      if (status) {
        where.status = status;
      }

      const bookings = await prisma.booking.findMany({
        where,
        include: {
          reader: true,
          client: true
        },
        orderBy: { startTime: 'asc' },
        take: limit,
        skip: offset
      });

      // Convert times to user's timezone
      const userBookings = bookings.map(booking => ({
        ...booking,
        startTime: moment.utc(booking.startTime).tz(timezone).format(),
        endTime: moment.utc(booking.endTime).tz(timezone).format()
      }));

      return userBookings;
    } catch (error) {
      throw handlePrismaError(error);
    }
  }

  /**
   * Check for booking conflicts
   */
  async checkBookingConflicts(readerId, startTime, endTime, excludeBookingId = null) {
    try {
      const where = {
        readerId,
        status: { in: ['confirmed', 'pending'] },
        OR: [
          {
            startTime: { lt: endTime },
            endTime: { gt: startTime }
          }
        ]
      };

      if (excludeBookingId) {
        where.id = { not: excludeBookingId };
      }

      const conflictingBookings = await prisma.booking.findMany({ where });
      return conflictingBookings.length > 0;
    } catch (error) {
      throw handlePrismaError(error);
    }
  }

  /**
   * Validate booking time
   */
  async validateBookingTime(readerId, startTime, endTime) {
    const now = new Date();
    const minAdvanceTime = new Date(now.getTime() + this.minBookingAdvance * 60000);
    const maxAdvanceTime = new Date(now.getTime() + this.maxBookingAdvance * 24 * 60 * 60 * 1000);

    if (startTime < minAdvanceTime) {
      throw new Error(`Booking must be at least ${this.minBookingAdvance} minutes in advance`);
    }

    if (startTime > maxAdvanceTime) {
      throw new Error(`Booking cannot be more than ${this.maxBookingAdvance} days in advance`);
    }

    if (startTime >= endTime) {
      throw new Error('Start time must be before end time');
    }

    // Check if reader is available during this time
    const availability = await prisma.availability.findUnique({
      where: { readerId }
    });

    if (!availability) {
      throw new Error('Reader has not set their availability');
    }

    // Validate against business hours and availability patterns
    const isAvailable = await this.isTimeSlotAvailable(
      availability,
      startTime,
      endTime
    );

    if (!isAvailable) {
      throw new Error('Reader is not available during the requested time');
    }
  }

  /**
   * Check if a time slot is available based on reader's availability
   */
  async isTimeSlotAvailable(availability, startTime, endTime) {
    // Check against blackout dates
    const isBlackedOut = availability.blackoutDates.some(blackout => {
      const blackoutStart = new Date(blackout.startDate);
      const blackoutEnd = new Date(blackout.endDate);
      return startTime < blackoutEnd && endTime > blackoutStart;
    });

    if (isBlackedOut) {
      return false;
    }

    // Check against recurring patterns
    const dayOfWeek = moment.utc(startTime).day();
    const timeOfDay = moment.utc(startTime).format('HH:mm');

    // Check if the day/time matches any recurring pattern
    const hasRecurringAvailability = availability.recurringPattern.some(pattern => {
      return pattern.daysOfWeek.includes(dayOfWeek) &&
             timeOfDay >= pattern.startTime &&
             timeOfDay <= pattern.endTime;
    });

    // Check specific dates
    const hasSpecificAvailability = availability.specificDates.some(specific => {
      const specificDate = moment.utc(specific.date).format('YYYY-MM-DD');
      const requestDate = moment.utc(startTime).format('YYYY-MM-DD');
      return specificDate === requestDate &&
             timeOfDay >= specific.startTime &&
             timeOfDay <= specific.endTime;
    });

    return hasRecurringAvailability || hasSpecificAvailability;
  }

  /**
   * Convert recurring pattern to UTC
   */
  convertRecurringPatternToUTC(patterns, timezone) {
    return patterns.map(pattern => ({
      ...pattern,
      startTime: moment.tz(`2000-01-01 ${pattern.startTime}`, timezone).utc().format('HH:mm'),
      endTime: moment.tz(`2000-01-01 ${pattern.endTime}`, timezone).utc().format('HH:mm')
    }));
  }

  /**
   * Convert dates to UTC
   */
  convertDatesToUTC(dates, timezone) {
    return dates.map(date => ({
      ...date,
      date: moment.tz(date.date, timezone).utc().toDate(),
      startTime: date.startTime ? moment.tz(`${date.date} ${date.startTime}`, timezone).utc().format('HH:mm') : null,
      endTime: date.endTime ? moment.tz(`${date.date} ${date.endTime}`, timezone).utc().format('HH:mm') : null
    }));
  }

  /**
   * Generate recurring slots
   */
  generateRecurringSlots(patterns, startDate, endDate, timezone) {
    const slots = [];
    const start = moment.tz(startDate, timezone);
    const end = moment.tz(endDate, timezone);

    patterns.forEach(pattern => {
      let current = start.clone();
      
      while (current.isBefore(end)) {
        if (pattern.daysOfWeek.includes(current.day())) {
          const slotStart = current.clone().set({
            hour: moment(pattern.startTime, 'HH:mm').hour(),
            minute: moment(pattern.startTime, 'HH:mm').minute(),
            second: 0,
            millisecond: 0
          });
          
          const slotEnd = current.clone().set({
            hour: moment(pattern.endTime, 'HH:mm').hour(),
            minute: moment(pattern.endTime, 'HH:mm').minute(),
            second: 0,
            millisecond: 0
          });

          if (slotStart.isBetween(start, end, null, '[]')) {
            slots.push({
              startTime: slotStart.utc().toDate(),
              endTime: slotEnd.utc().toDate(),
              type: 'recurring'
            });
          }
        }
        current.add(1, 'day');
      }
    });

    return slots;
  }

  /**
   * Generate specific date slots
   */
  generateSpecificDateSlots(specificDates, startDate, endDate) {
    const slots = [];
    const start = moment.utc(startDate);
    const end = moment.utc(endDate);

    specificDates.forEach(specific => {
      const specificMoment = moment.utc(specific.date);
      
      if (specificMoment.isBetween(start, end, null, '[]')) {
        slots.push({
          startTime: moment.utc(`${specific.date} ${specific.startTime}`).toDate(),
          endTime: moment.utc(`${specific.date} ${specific.endTime}`).toDate(),
          type: 'specific'
        });
      }
    });

    return slots;
  }

  /**
   * Remove blackout dates from slots
   */
  removeBlackoutDates(slots, blackoutDates) {
    return slots.filter(slot => {
      return !blackoutDates.some(blackout => {
        const blackoutStart = moment.utc(blackout.startDate);
        const blackoutEnd = moment.utc(blackout.endDate);
        const slotStart = moment.utc(slot.startTime);
        const slotEnd = moment.utc(slot.endTime);
        
        return slotStart.isBefore(blackoutEnd) && slotEnd.isAfter(blackoutStart);
      });
    });
  }

  /**
   * Get booked slots for a reader
   */
  async getBookedSlots(readerId, startDate, endDate) {
    try {
      const bookings = await prisma.booking.findMany({
        where: {
          readerId,
          status: { in: ['confirmed', 'pending'] },
          startTime: { gte: moment.utc(startDate).toDate() },
          endTime: { lte: moment.utc(endDate).toDate() }
        }
      });

      return bookings.map(booking => ({
        startTime: booking.startTime,
        endTime: booking.endTime
      }));
    } catch (error) {
      throw handlePrismaError(error);
    }
  }

  /**
   * Remove booked slots from available slots
   */
  removeBookedSlots(availableSlots, bookedSlots) {
    return availableSlots.filter(available => {
      return !bookedSlots.some(booked => {
        const availableStart = moment.utc(available.startTime);
        const availableEnd = moment.utc(available.endTime);
        const bookedStart = moment.utc(booked.startTime);
        const bookedEnd = moment.utc(booked.endTime);
        
        return availableStart.isBefore(bookedEnd) && availableEnd.isAfter(bookedStart);
      });
    });
  }

  /**
   * Schedule reminders for a booking
   */
  async scheduleReminders(booking) {
    try {
      const reminders = [
        { type: '24h', time: moment.utc(booking.startTime).subtract(24, 'hours').toDate() },
        { type: '1h', time: moment.utc(booking.startTime).subtract(1, 'hour').toDate() },
        { type: '15m', time: moment.utc(booking.startTime).subtract(15, 'minutes').toDate() }
      ];

      const now = new Date();
      const validReminders = reminders.filter(reminder => reminder.time > now);

      for (const reminder of validReminders) {
        await prisma.reminder.create({
          data: {
            bookingId: booking.id,
            type: reminder.type,
            scheduledFor: reminder.time,
            status: 'pending'
          }
        });
      }
    } catch (error) {
      throw handlePrismaError(error);
    }
  }

  /**
   * Reschedule reminders for an updated booking
   */
  async rescheduleReminders(booking) {
    try {
      // Cancel existing reminders
      await this.cancelReminders(booking.id);
      
      // Schedule new reminders
      await this.scheduleReminders(booking);
    } catch (error) {
      throw handlePrismaError(error);
    }
  }

  /**
   * Cancel reminders for a booking
   */
  async cancelReminders(bookingId) {
    try {
      await prisma.reminder.updateMany({
        where: {
          bookingId,
          status: 'pending'
        },
        data: {
          status: 'cancelled'
        }
      });
    } catch (error) {
      throw handlePrismaError(error);
    }
  }

  /**
   * Process pending reminders
   */
  async processPendingReminders() {
    try {
      const now = new Date();
      const pendingReminders = await prisma.reminder.findMany({
        where: {
          status: 'pending',
          scheduledFor: { lte: now }
        },
        include: {
          booking: {
            include: {
              reader: true,
              client: true
            }
          }
        }
      });

      for (const reminder of pendingReminders) {
        try {
          await this.sendReminder(reminder);
          
          await prisma.reminder.update({
            where: { id: reminder.id },
            data: { 
              status: 'sent',
              sentAt: new Date()
            }
          });
        } catch (error) {
          console.error(`Failed to send reminder ${reminder.id}:`, error);
          
          await prisma.reminder.update({
            where: { id: reminder.id },
            data: { 
              status: 'failed',
              error: error.message
            }
          });
        }
      }

      return pendingReminders.length;
    } catch (error) {
      throw handlePrismaError(error);
    }
  }

  /**
   * Send a reminder notification
   */
  async sendReminder(reminder) {
    const { booking } = reminder;
    const startTime = moment.utc(booking.startTime).tz(booking.timezone);
    
    // This would integrate with your notification system
    // For now, we'll just log the reminder
    console.log(`Reminder: ${reminder.type} for booking ${booking.id}`);
    console.log(`Client: ${booking.client.email}, Reader: ${booking.reader.email}`);
    console.log(`Scheduled for: ${startTime.format('YYYY-MM-DD HH:mm z')}`);
    
    // TODO: Integrate with actual notification service (email, SMS, push notifications)
  }

  /**
   * Get upcoming bookings for reminders
   */
  async getUpcomingBookings(hours = 24) {
    try {
      const now = new Date();
      const futureTime = new Date(now.getTime() + hours * 60 * 60 * 1000);

      return await prisma.booking.findMany({
        where: {
          status: 'confirmed',
          startTime: {
            gte: now,
            lte: futureTime
          }
        },
        include: {
          reader: true,
          client: true
        },
        orderBy: { startTime: 'asc' }
      });
    } catch (error) {
      throw handlePrismaError(error);
    }
  }

  /**
   * Handle holiday management
   */
  async setHolidays(readerId, holidays) {
    try {
      const holidayBlackouts = holidays.map(holiday => ({
        name: holiday.name,
        startDate: moment.tz(holiday.date, holiday.timezone || 'UTC').startOf('day').utc().toDate(),
        endDate: moment.tz(holiday.date, holiday.timezone || 'UTC').endOf('day').utc().toDate(),
        type: 'holiday',
        isRecurring: holiday.isRecurring || false
      }));

      const availability = await prisma.availability.findUnique({
        where: { readerId }
      });

      if (!availability) {
        throw new Error('Reader availability not found');
      }

      const updatedBlackouts = [
        ...availability.blackoutDates.filter(b => b.type !== 'holiday'),
        ...holidayBlackouts
      ];

      return await prisma.availability.update({
        where: { readerId },
        data: {
          blackoutDates: updatedBlackouts
        }
      });
    } catch (error) {
      throw handlePrismaError(error);
    }
  }

  /**
   * Get reader statistics
   */
  async getReaderStats(readerId, startDate, endDate) {
    try {
      const bookings = await prisma.booking.findMany({
        where: {
          readerId,
          startTime: {
            gte: moment.utc(startDate).toDate(),
            lte: moment.utc(endDate).toDate()
          }
        }
      });

      const totalBookings = bookings.length;
      const completedBookings = bookings.filter(b => b.status === 'completed').length;
      const cancelledBookings = bookings.filter(b => b.status === 'cancelled').length;
      const totalMinutes = bookings
        .filter(b => b.status === 'completed')
        .reduce((sum, b) => sum + moment(b.endTime).diff(moment(b.startTime), 'minutes'), 0);

      return {
        totalBookings,
        completedBookings,
        cancelledBookings,
        completionRate: totalBookings > 0 ? (completedBookings / totalBookings) * 100 : 0,
        totalMinutes,
        averageSessionLength: completedBookings > 0 ? totalMinutes / completedBookings : 0
      };
    } catch (error) {
      throw handlePrismaError(error);
    }
  }
}

// Create singleton instance
const schedulingManager = new SchedulingManager();

module.exports = schedulingManager;