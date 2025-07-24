const { prisma, handlePrismaError } = require('../lib/prisma');
const nodemailer = require('nodemailer');
const twilio = require('twilio');

/**
 * Comprehensive Notification System for SoulSeer
 * Handles real-time notifications via Socket.io, email, and SMS
 * Supports session requests, booking confirmations, payments, and system messages
 */

class NotificationService {
  constructor() {
    this.io = null;
    this.emailTransporter = null;
    this.twilioClient = null;
    this.userSockets = new Map(); // userId -> socketId mapping
    this.notificationQueue = [];
    this.isProcessing = false;
    
    this.initializeServices();
  }

  /**
   * Initialize external services (email, SMS)
   */
  initializeServices() {
    // Initialize email transporter
    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
      this.emailTransporter = nodemailer.createTransporter({
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT || 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      });
    }

    // Initialize Twilio client
    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
      this.twilioClient = twilio(
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_AUTH_TOKEN
      );
    }
  }

  /**
   * Set Socket.io instance
   */
  setSocketIO(io) {
    this.io = io;
    this.setupSocketHandlers();
  }

  /**
   * Setup Socket.io event handlers for notifications
   */
  setupSocketHandlers() {
    if (!this.io) return;

    this.io.on('connection', (socket) => {
      // Register user socket for notifications
      socket.on('register-notifications', (userId) => {
        this.userSockets.set(userId, socket.id);
        console.log(`User ${userId} registered for notifications with socket ${socket.id}`);
      });

      // Handle notification preferences update
      socket.on('update-notification-preferences', async (data) => {
        try {
          await this.updateNotificationPreferences(data.userId, data.preferences);
          socket.emit('preferences-updated', { success: true });
        } catch (error) {
          socket.emit('preferences-updated', { success: false, error: error.message });
        }
      });

      // Mark notification as read
      socket.on('mark-notification-read', async (notificationId) => {
        try {
          await this.markNotificationAsRead(notificationId);
          socket.emit('notification-marked-read', { notificationId, success: true });
        } catch (error) {
          socket.emit('notification-marked-read', { notificationId, success: false, error: error.message });
        }
      });

      // Clean up on disconnect
      socket.on('disconnect', () => {
        for (const [userId, socketId] of this.userSockets.entries()) {
          if (socketId === socket.id) {
            this.userSockets.delete(userId);
            console.log(`User ${userId} disconnected from notifications`);
            break;
          }
        }
      });
    });
  }

  /**
   * Main notification dispatch method
   */
  async sendNotification(notification) {
    try {
      // Validate notification data
      this.validateNotification(notification);

      // Get user and their preferences
      const user = await this.getUserWithPreferences(notification.userId);
      if (!user) {
        throw new Error(`User not found: ${notification.userId}`);
      }

      // Store notification in database
      const savedNotification = await this.saveNotification(notification);

      // Determine delivery channels based on user preferences and notification type
      const channels = this.determineDeliveryChannels(user, notification);

      // Send via each channel
      const results = await Promise.allSettled([
        this.sendRealTimeNotification(user, savedNotification, channels.realTime),
        this.sendEmailNotification(user, savedNotification, channels.email),
        this.sendSMSNotification(user, savedNotification, channels.sms)
      ]);

      // Log results
      this.logNotificationResults(savedNotification.id, results);

      return savedNotification;
    } catch (error) {
      console.error('Notification send error:', error);
      throw handlePrismaError(error);
    }
  }

  /**
   * Send session request notification
   */
  async sendSessionRequestNotification(readerId, sessionData) {
    const notification = {
      userId: readerId,
      type: 'session_request',
      title: 'New Session Request',
      message: `You have a new session request from ${sessionData.clientName}`,
      data: {
        sessionId: sessionData.id,
        clientId: sessionData.clientId,
        clientName: sessionData.clientName,
        serviceType: sessionData.serviceType,
        requestedAt: sessionData.createdAt
      },
      priority: 'high',
      channels: ['realTime', 'email'] // High priority for session requests
    };

    return await this.sendNotification(notification);
  }

  /**
   * Send booking confirmation notification
   */
  async sendBookingConfirmationNotification(userId, bookingData) {
    const notification = {
      userId,
      type: 'booking_confirmation',
      title: 'Booking Confirmed',
      message: `Your reading with ${bookingData.readerName} is confirmed for ${bookingData.scheduledAt}`,
      data: {
        bookingId: bookingData.id,
        readerId: bookingData.readerId,
        readerName: bookingData.readerName,
        scheduledAt: bookingData.scheduledAt,
        serviceType: bookingData.serviceType,
        duration: bookingData.duration
      },
      priority: 'medium',
      channels: ['realTime', 'email']
    };

    return await this.sendNotification(notification);
  }

  /**
   * Send payment notification
   */
  async sendPaymentNotification(userId, paymentData) {
    const isSuccess = paymentData.status === 'succeeded';
    const notification = {
      userId,
      type: isSuccess ? 'payment_success' : 'payment_failed',
      title: isSuccess ? 'Payment Successful' : 'Payment Failed',
      message: isSuccess 
        ? `Payment of $${paymentData.amount} processed successfully`
        : `Payment of $${paymentData.amount} failed: ${paymentData.error}`,
      data: {
        transactionId: paymentData.transactionId,
        amount: paymentData.amount,
        currency: paymentData.currency,
        status: paymentData.status,
        sessionId: paymentData.sessionId,
        error: paymentData.error
      },
      priority: isSuccess ? 'medium' : 'high',
      channels: ['realTime', 'email']
    };

    return await this.sendNotification(notification);
  }

  /**
   * Send system message notification
   */
  async sendSystemNotification(userId, messageData) {
    const notification = {
      userId,
      type: 'system_message',
      title: messageData.title || 'System Notification',
      message: messageData.message,
      data: messageData.data || {},
      priority: messageData.priority || 'low',
      channels: messageData.channels || ['realTime']
    };

    return await this.sendNotification(notification);
  }

  /**
   * Send session reminder notification
   */
  async sendSessionReminderNotification(userId, sessionData) {
    const notification = {
      userId,
      type: 'session_reminder',
      title: 'Upcoming Session Reminder',
      message: `Your session with ${sessionData.readerName || sessionData.clientName} starts in ${sessionData.minutesUntil} minutes`,
      data: {
        sessionId: sessionData.id,
        scheduledAt: sessionData.scheduledAt,
        minutesUntil: sessionData.minutesUntil,
        serviceType: sessionData.serviceType
      },
      priority: 'high',
      channels: ['realTime', 'sms'] // SMS for important reminders
    };

    return await this.sendNotification(notification);
  }

  /**
   * Send real-time notification via Socket.io
   */
  async sendRealTimeNotification(user, notification, enabled) {
    if (!enabled || !this.io) return { success: false, reason: 'Real-time disabled or Socket.io not available' };

    const socketId = this.userSockets.get(user.id);
    if (!socketId) {
      return { success: false, reason: 'User not connected' };
    }

    try {
      this.io.to(socketId).emit('notification', {
        id: notification.id,
        type: notification.type,
        title: notification.title,
        message: notification.message,
        data: notification.data,
        priority: notification.priority,
        createdAt: notification.createdAt
      });

      return { success: true, channel: 'realTime' };
    } catch (error) {
      console.error('Real-time notification error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send email notification
   */
  async sendEmailNotification(user, notification, enabled) {
    if (!enabled || !this.emailTransporter || !user.email) {
      return { success: false, reason: 'Email disabled or not configured' };
    }

    try {
      const emailTemplate = this.generateEmailTemplate(notification);
      
      const mailOptions = {
        from: process.env.SMTP_FROM || 'SoulSeer <noreply@soulseer.com>',
        to: user.email,
        subject: notification.title,
        html: emailTemplate.html,
        text: emailTemplate.text
      };

      const result = await this.emailTransporter.sendMail(mailOptions);
      return { success: true, channel: 'email', messageId: result.messageId };
    } catch (error) {
      console.error('Email notification error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send SMS notification
   */
  async sendSMSNotification(user, notification, enabled) {
    if (!enabled || !this.twilioClient || !user.phone) {
      return { success: false, reason: 'SMS disabled or not configured' };
    }

    try {
      const smsMessage = this.generateSMSMessage(notification);
      
      const result = await this.twilioClient.messages.create({
        body: smsMessage,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: user.phone
      });

      return { success: true, channel: 'sms', messageId: result.sid };
    } catch (error) {
      console.error('SMS notification error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get user with notification preferences
   */
  async getUserWithPreferences(userId) {
    try {
      return await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          phone: true,
          firstName: true,
          lastName: true,
          notificationPreferences: true
        }
      });
    } catch (error) {
      throw handlePrismaError(error);
    }
  }

  /**
   * Save notification to database
   */
  async saveNotification(notification) {
    try {
      return await prisma.notification.create({
        data: {
          userId: notification.userId,
          type: notification.type,
          title: notification.title,
          message: notification.message,
          data: notification.data || {},
          priority: notification.priority || 'medium',
          isRead: false,
          deliveryChannels: notification.channels || ['realTime']
        }
      });
    } catch (error) {
      throw handlePrismaError(error);
    }
  }

  /**
   * Determine which delivery channels to use
   */
  determineDeliveryChannels(user, notification) {
    const preferences = user.notificationPreferences || {};
    const defaultPreferences = {
      realTime: true,
      email: true,
      sms: false
    };

    // Merge user preferences with defaults
    const userPrefs = { ...defaultPreferences, ...preferences };

    // Override based on notification type and priority
    const channels = {
      realTime: userPrefs.realTime,
      email: userPrefs.email,
      sms: userPrefs.sms
    };

    // Force certain channels for high priority notifications
    if (notification.priority === 'high') {
      channels.realTime = true;
      if (notification.type === 'session_request' || notification.type === 'session_reminder') {
        channels.email = true;
      }
    }

    // Respect explicit channel preferences in notification
    if (notification.channels) {
      channels.realTime = notification.channels.includes('realTime');
      channels.email = notification.channels.includes('email');
      channels.sms = notification.channels.includes('sms');
    }

    return channels;
  }

  /**
   * Generate email template
   */
  generateEmailTemplate(notification) {
    const baseTemplate = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>${notification.title}</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #6366f1; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
          .button { display: inline-block; padding: 10px 20px; background: #6366f1; color: white; text-decoration: none; border-radius: 5px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>SoulSeer</h1>
          </div>
          <div class="content">
            <h2>${notification.title}</h2>
            <p>${notification.message}</p>
            ${this.generateNotificationSpecificContent(notification)}
          </div>
          <div class="footer">
            <p>This is an automated message from SoulSeer. Please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    const textTemplate = `
      SoulSeer Notification
      
      ${notification.title}
      
      ${notification.message}
      
      ${this.generateNotificationSpecificText(notification)}
      
      ---
      This is an automated message from SoulSeer.
    `;

    return {
      html: baseTemplate,
      text: textTemplate
    };
  }

  /**
   * Generate notification-specific email content
   */
  generateNotificationSpecificContent(notification) {
    switch (notification.type) {
      case 'session_request':
        return `
          <p><strong>Session Details:</strong></p>
          <ul>
            <li>Service Type: ${notification.data.serviceType}</li>
            <li>Requested At: ${new Date(notification.data.requestedAt).toLocaleString()}</li>
          </ul>
          <p><a href="${process.env.CLIENT_URL}/dashboard" class="button">View Request</a></p>
        `;
      
      case 'booking_confirmation':
        return `
          <p><strong>Booking Details:</strong></p>
          <ul>
            <li>Reader: ${notification.data.readerName}</li>
            <li>Scheduled: ${new Date(notification.data.scheduledAt).toLocaleString()}</li>
            <li>Duration: ${notification.data.duration} minutes</li>
            <li>Service: ${notification.data.serviceType}</li>
          </ul>
          <p><a href="${process.env.CLIENT_URL}/bookings/${notification.data.bookingId}" class="button">View Booking</a></p>
        `;
      
      case 'payment_success':
        return `
          <p><strong>Payment Details:</strong></p>
          <ul>
            <li>Amount: $${notification.data.amount}</li>
            <li>Transaction ID: ${notification.data.transactionId}</li>
          </ul>
        `;
      
      case 'payment_failed':
        return `
          <p><strong>Payment Details:</strong></p>
          <ul>
            <li>Amount: $${notification.data.amount}</li>
            <li>Error: ${notification.data.error}</li>
          </ul>
          <p><a href="${process.env.CLIENT_URL}/billing" class="button">Update Payment Method</a></p>
        `;
      
      default:
        return '';
    }
  }

  /**
   * Generate notification-specific text content
   */
  generateNotificationSpecificText(notification) {
    switch (notification.type) {
      case 'session_request':
        return `Service Type: ${notification.data.serviceType}\nRequested At: ${new Date(notification.data.requestedAt).toLocaleString()}`;
      
      case 'booking_confirmation':
        return `Reader: ${notification.data.readerName}\nScheduled: ${new Date(notification.data.scheduledAt).toLocaleString()}\nDuration: ${notification.data.duration} minutes`;
      
      case 'payment_success':
        return `Amount: $${notification.data.amount}\nTransaction ID: ${notification.data.transactionId}`;
      
      case 'payment_failed':
        return `Amount: $${notification.data.amount}\nError: ${notification.data.error}`;
      
      default:
        return '';
    }
  }

  /**
   * Generate SMS message
   */
  generateSMSMessage(notification) {
    let message = `SoulSeer: ${notification.title}\n\n${notification.message}`;
    
    // Keep SMS messages concise
    if (message.length > 160) {
      message = message.substring(0, 157) + '...';
    }
    
    return message;
  }

  /**
   * Update user notification preferences
   */
  async updateNotificationPreferences(userId, preferences) {
    try {
      return await prisma.user.update({
        where: { id: userId },
        data: {
          notificationPreferences: preferences
        }
      });
    } catch (error) {
      throw handlePrismaError(error);
    }
  }

  /**
   * Mark notification as read
   */
  async markNotificationAsRead(notificationId) {
    try {
      return await prisma.notification.update({
        where: { id: notificationId },
        data: {
          isRead: true,
          readAt: new Date()
        }
      });
    } catch (error) {
      throw handlePrismaError(error);
    }
  }

  /**
   * Get user notifications
   */
  async getUserNotifications(userId, options = {}) {
    try {
      const { page = 1, limit = 20, unreadOnly = false } = options;
      const skip = (page - 1) * limit;

      const where = {
        userId,
        ...(unreadOnly && { isRead: false })
      };

      const notifications = await prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      });

      const total = await prisma.notification.count({ where });

      return {
        notifications,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      };
    } catch (error) {
      throw handlePrismaError(error);
    }
  }

  /**
   * Get unread notification count
   */
  async getUnreadCount(userId) {
    try {
      return await prisma.notification.count({
        where: {
          userId,
          isRead: false
        }
      });
    } catch (error) {
      throw handlePrismaError(error);
    }
  }

  /**
   * Validate notification data
   */
  validateNotification(notification) {
    if (!notification.userId) {
      throw new Error('User ID is required');
    }
    if (!notification.type) {
      throw new Error('Notification type is required');
    }
    if (!notification.title) {
      throw new Error('Notification title is required');
    }
    if (!notification.message) {
      throw new Error('Notification message is required');
    }
  }

  /**
   * Log notification results
   */
  logNotificationResults(notificationId, results) {
    console.log(`Notification ${notificationId} delivery results:`, {
      realTime: results[0].status === 'fulfilled' ? results[0].value : results[0].reason,
      email: results[1].status === 'fulfilled' ? results[1].value : results[1].reason,
      sms: results[2].status === 'fulfilled' ? results[2].value : results[2].reason
    });
  }

  /**
   * Bulk send notifications
   */
  async sendBulkNotifications(notifications) {
    const results = [];
    
    for (const notification of notifications) {
      try {
        const result = await this.sendNotification(notification);
        results.push({ success: true, notificationId: result.id });
      } catch (error) {
        results.push({ success: false, error: error.message, notification });
      }
    }
    
    return results;
  }

  /**
   * Schedule notification for later delivery
   */
  async scheduleNotification(notification, deliveryTime) {
    try {
      return await prisma.scheduledNotification.create({
        data: {
          ...notification,
          scheduledFor: deliveryTime,
          status: 'pending'
        }
      });
    } catch (error) {
      throw handlePrismaError(error);
    }
  }

  /**
   * Process scheduled notifications
   */
  async processScheduledNotifications() {
    try {
      const now = new Date();
      const pendingNotifications = await prisma.scheduledNotification.findMany({
        where: {
          scheduledFor: { lte: now },
          status: 'pending'
        }
      });

      for (const scheduled of pendingNotifications) {
        try {
          await this.sendNotification({
            userId: scheduled.userId,
            type: scheduled.type,
            title: scheduled.title,
            message: scheduled.message,
            data: scheduled.data,
            priority: scheduled.priority,
            channels: scheduled.deliveryChannels
          });

          await prisma.scheduledNotification.update({
            where: { id: scheduled.id },
            data: { status: 'sent', sentAt: new Date() }
          });
        } catch (error) {
          console.error(`Failed to send scheduled notification ${scheduled.id}:`, error);
          await prisma.scheduledNotification.update({
            where: { id: scheduled.id },
            data: { status: 'failed', error: error.message }
          });
        }
      }
    } catch (error) {
      console.error('Error processing scheduled notifications:', error);
    }
  }
}

// Create singleton instance
const notificationService = new NotificationService();

// Export service and helper functions
module.exports = {
  notificationService,
  
  // Convenience functions
  sendSessionRequest: (readerId, sessionData) => 
    notificationService.sendSessionRequestNotification(readerId, sessionData),
  
  sendBookingConfirmation: (userId, bookingData) => 
    notificationService.sendBookingConfirmationNotification(userId, bookingData),
  
  sendPaymentNotification: (userId, paymentData) => 
    notificationService.sendPaymentNotification(userId, paymentData),
  
  sendSystemNotification: (userId, messageData) => 
    notificationService.sendSystemNotification(userId, messageData),
  
  sendSessionReminder: (userId, sessionData) => 
    notificationService.sendSessionReminderNotification(userId, sessionData),
  
  getUserNotifications: (userId, options) => 
    notificationService.getUserNotifications(userId, options),
  
  getUnreadCount: (userId) => 
    notificationService.getUnreadCount(userId),
  
  markAsRead: (notificationId) => 
    notificationService.markNotificationAsRead(notificationId),
  
  updatePreferences: (userId, preferences) => 
    notificationService.updateNotificationPreferences(userId, preferences),
  
  setSocketIO: (io) => 
    notificationService.setSocketIO(io),
  
  scheduleNotification: (notification, deliveryTime) => 
    notificationService.scheduleNotification(notification, deliveryTime),
  
  processScheduledNotifications: () => 
    notificationService.processScheduledNotifications()
};