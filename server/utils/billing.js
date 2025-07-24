const { prisma } = require('../lib/prisma');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

class BillingManager {
  constructor() {
    this.activeBillingIntervals = new Map();
    this.PLATFORM_FEE_RATE = 0.30; // 30%
    this.READER_SHARE_RATE = 0.70; // 70%
    this.MINIMUM_PAYOUT = 15.00; // $15
  }

  // Start billing for a session
  startSessionBilling(sessionId, clientId, readerId, ratePerMinute) {
    if (this.activeBillingIntervals.has(sessionId)) {
      console.log(`Billing already active for session ${sessionId}`);
      return;
    }

    console.log(`Starting billing for session ${sessionId} at $${ratePerMinute}/min`);

    const billingInterval = setInterval(async () => {
      try {
        await this.processMinuteBilling(sessionId, clientId, readerId, ratePerMinute);
      } catch (error) {
        console.error(`Billing error for session ${sessionId}:`, error);
        this.stopSessionBilling(sessionId);
      }
    }, 60000); // Bill every minute

    this.activeBillingIntervals.set(sessionId, {
      interval: billingInterval,
      clientId,
      readerId,
      rate: ratePerMinute,
      startTime: new Date()
    });
  }

  // Stop billing for a session
  stopSessionBilling(sessionId) {
    const billingData = this.activeBillingIntervals.get(sessionId);
    if (billingData) {
      clearInterval(billingData.interval);
      this.activeBillingIntervals.delete(sessionId);
      console.log(`Stopped billing for session ${sessionId}`);
    }
  }

  // Process a single minute of billing
  async processMinuteBilling(sessionId, clientId, readerId, ratePerMinute) {
    try {
      // Get current session and user data
      const [session, client, reader] = await Promise.all([
        prisma.session.findFirst({
          where: { sessionId, status: 'active' }
        }),
        prisma.user.findUnique({ where: { id: clientId } }),
        prisma.user.findUnique({ where: { id: readerId } })
      ]);

      if (!session || !client || !reader) {
        throw new Error('Session or users not found');
      }

      // Check if client has sufficient balance
      if (client.balance < ratePerMinute) {
        console.log(`Insufficient balance for session ${sessionId}. Ending session.`);
        await this.endSessionDueToInsufficientFunds(session);
        this.stopSessionBilling(sessionId);
        return;
      }

      // Calculate earnings split
      const platformFee = ratePerMinute * this.PLATFORM_FEE_RATE;
      const readerEarnings = ratePerMinute * this.READER_SHARE_RATE;

      // Process the charge
      await this.processCharge(client, reader, session, ratePerMinute, platformFee, readerEarnings);

      console.log(`Billed $${ratePerMinute} for session ${sessionId}`);
    } catch (error) {
      console.error('Minute billing error:', error);
      throw error;
    }
  }

  // Process the actual charge
  async processCharge(client, reader, session, amount, platformFee, readerEarnings) {
    // Execute all updates and transaction record in a single database transaction
    const balanceBefore = client.balance;
    const balanceAfter = balanceBefore - amount;

    const [updatedClient] = await prisma.$transaction([
      prisma.user.update({
        where: { id: client.id },
        data: { balance: { decrement: amount } }
      }),
      prisma.user.update({
        where: { id: reader.id },
        data: {
          earnings: {
            // assuming earnings is JSON in Prisma schema
            set: {
              ...reader.earnings,
              pending: (reader.earnings?.pending || 0) + readerEarnings,
              total: (reader.earnings?.total || 0) + readerEarnings
            }
          }
        }
      }),
      prisma.session.update({
        where: { id: session.id },
        data: {
          totalCost: { increment: amount },
          platformFee: { increment: platformFee },
          readerEarnings: { increment: readerEarnings }
        }
      }),
      prisma.transaction.create({
        data: {
          userId: client.id,
          sessionId: session.id,
          type: 'charge',
          amount,
          status: 'succeeded',
          description: `Session charge - ${session.sessionType}`,
          balanceBefore,
          balanceAfter,
          fees: {
            stripeFee: 0,
            platformFee,
            totalFees: platformFee
          },
          metadata: {
            sessionType: session.sessionType,
            readerId: reader.id,
            clientId: client.id,
            readerEarnings
          }
        }
      })
    ]);

    return updatedClient;
  }

  // End session due to insufficient funds
  async endSessionDueToInsufficientFunds(session) {
    const endTime = new Date();
    const startTime = new Date(session.startTime);
    const duration = session.startTime ? Math.floor((endTime - startTime) / 1000) : 0;

    await prisma.session.update({
      where: { id: session.id },
      data: {
        status: 'ended',
        endTime,
        duration,
        notes: {
          // overwrite or set admin note
          admin: 'Session ended due to insufficient client balance'
        }
      }
    });

    console.log(`Session ${session.sessionId} ended due to insufficient balance`);
  }

  // Process automatic payouts for readers
  async processAutomaticPayouts() {
    try {
      console.log('Processing automatic payouts...');

      // Find readers eligible for payout
      const eligibleReaders = await prisma.user.findMany({
        where: {
          role: 'reader',
          isActive: true,
          stripeAccountId: { not: null },
          // assuming earnings is stored as JSON or separate fields
          AND: [
            { earnings: { path: ['pending'], gte: this.MINIMUM_PAYOUT } }
          ]
        }
      });

      const results = [];

      for (const reader of eligibleReaders) {
        try {
          const payoutResult = await this.processReaderPayout(reader);
          results.push({
            readerId: reader.id,
            email: reader.email,
            amount: payoutResult.amount,
            status: 'success',
            transferId: payoutResult.transferId
          });
        } catch (error) {
          console.error(`Payout failed for reader ${reader.id}:`, error);
          results.push({
            readerId: reader.id,
            email: reader.email,
            amount: reader.earnings?.pending || 0,
            status: 'failed',
            error: error.message
          });
        }
      }

      console.log(`Processed ${results.filter(r => r.status === 'success').length} automatic payouts`);
      return results;
    } catch (error) {
      console.error('Automatic payout processing error:', error);
      throw error;
    }
  }

  // Process individual reader payout
  async processReaderPayout(reader) {
    const payoutAmount = reader.earnings?.pending || 0;

    // Check Stripe account status
    const account = await stripe.accounts.retrieve(reader.stripeAccountId);
    if (!account.payouts_enabled) {
      throw new Error('Stripe account not ready for payouts');
    }

    // Create Stripe transfer
    const transfer = await stripe.transfers.create({
      amount: Math.round(payoutAmount * 100), // Convert to cents
      currency: 'usd',
      destination: reader.stripeAccountId,
      metadata: {
        userId: reader.id.toString(),
        type: 'automatic_payout',
        originalAmount: payoutAmount.toString()
      },
      description: `SoulSeer automatic payout for ${reader.email}`
    });

    // Update reader earnings
    const newEarnings = {
      ...reader.earnings,
      pending: 0,
      paid: (reader.earnings?.paid || 0) + payoutAmount,
      lastPayout: new Date()
    };

    await prisma.user.update({
      where: { id: reader.id },
      data: { earnings: { set: newEarnings } }
    });

    // Create transaction record
    await prisma.transaction.create({
      data: {
        userId: reader.id,
        type: 'payout',
        amount: payoutAmount,
        stripeTransferId: transfer.id,
        status: 'succeeded',
        description: `Automatic payout - $${payoutAmount.toFixed(2)}`,
        metadata: {
          automaticPayout: true,
          stripeAccountId: reader.stripeAccountId
        }
      }
    });

    return {
      amount: payoutAmount,
      transferId: transfer.id
    };
  }

  // Add funds to client balance
  async addFundsToClient(clientId, amount, paymentIntentId) {
    try {
      const client = await prisma.user.findUnique({ where: { id: clientId } });
      if (!client) {
        throw new Error('Client not found');
      }

      const previousBalance = client.balance;
      const newBalance = previousBalance + amount;

      await prisma.user.update({
        where: { id: clientId },
        data: { balance: newBalance }
      });

      // Create transaction record
      await prisma.transaction.create({
        data: {
          userId: clientId,
          type: 'deposit',
          amount,
          stripePaymentIntentId: paymentIntentId,
          status: 'succeeded',
          description: `Balance top-up - $${amount.toFixed(2)}`,
          balanceBefore: previousBalance,
          balanceAfter: newBalance
        }
      });

      console.log(`Added $${amount} to client ${client.email} balance`);
      return { ...client, balance: newBalance };
    } catch (error) {
      console.error('Add funds error:', error);
      throw error;
    }
  }

  // Get billing statistics
  async getBillingStatistics(period = '30d') {
    try {
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
      }

      // Session statistics
      const sessionStats = await prisma.session.aggregate({
        where: {
          status: 'ended',
          endTime: { gte: startDate }
        },
        _count: { id: true },
        _sum: { totalCost: true, duration: true },
        _avg: { totalCost: true, duration: true }
      });

      const totalSessions = sessionStats._count.id || 0;
      const totalRevenue = sessionStats._sum.totalCost || 0;
      const totalDuration = sessionStats._sum.duration || 0;
      const averageSessionCost = sessionStats._avg.totalCost || 0;
      const averageSessionDuration = sessionStats._avg.duration || 0;

      // Transaction statistics
      const transactionStats = await prisma.transaction.groupBy({
        by: ['type'],
        where: {
          status: 'succeeded',
          createdAt: { gte: startDate }
        },
        _count: { type: true },
        _sum: { amount: true }
      });

      const transactionBreakdown = {};
      transactionStats.forEach(stat => {
        transactionBreakdown[stat.type] = {
          count: stat._count.type,
          totalAmount: stat._sum.amount || 0
        };
      });

      return {
        period,
        sessions: {
          totalSessions,
          totalRevenue,
          totalDuration,
          averageSessionCost,
          averageSessionDuration
        },
        transactions: transactionBreakdown,
        platformRevenue: totalRevenue * this.PLATFORM_FEE_RATE,
        readerEarnings: totalRevenue * this.READER_SHARE_RATE,
        activeBillingSessions: this.activeBillingIntervals.size
      };
    } catch (error) {
      console.error('Get billing statistics error:', error);
      throw error;
    }
  }

  // Get active billing sessions
  getActiveBillingSessions() {
    const sessions = [];
    for (const [sessionId, data] of this.activeBillingIntervals) {
      sessions.push({
        sessionId,
        clientId: data.clientId,
        readerId: data.readerId,
        rate: data.rate,
        startTime: data.startTime,
        duration: Math.floor((new Date() - data.startTime) / 1000)
      });
    }
    return sessions;
  }

  // Clean up billing for ended sessions
  cleanup() {
    console.log(`Cleaning up ${this.activeBillingIntervals.size} active billing intervals`);
    for (const [sessionId, data] of this.activeBillingIntervals) {
      clearInterval(data.interval);
    }
    this.activeBillingIntervals.clear();
  }
}

// Create singleton instance
const billingManager = new BillingManager();

// Schedule automatic payouts (run daily at 2 AM)
if (process.env.NODE_ENV === 'production') {
  const cron = require('node-cron');
  cron.schedule('0 2 * * *', async () => {
    try {
      console.log('Running scheduled automatic payouts...');
      await billingManager.processAutomaticPayouts();
    } catch (error) {
      console.error('Scheduled payout error:', error);
    }
  });
}

module.exports = billingManager;