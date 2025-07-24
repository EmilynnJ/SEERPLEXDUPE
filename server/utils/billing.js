const { prisma, executeTransaction, handlePrismaError } = require('../lib/prisma');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

class BillingManager {
  constructor() {
    this.platformFeeRate = 0.30; // 30% platform fee
    this.readerEarningsRate = 0.70; // 70% to reader
    this.minimumPayoutAmount = 15.00; // Minimum $15 for payout
  }

  // Process per-minute billing for active sessions
  async processMinuteBilling(sessionId, clientId, readerId, ratePerMinute) {
    try {
      // Get current session and user data
      const [session, client, reader] = await Promise.all([
        prisma.session.findFirst({
          where: { sessionId, status: 'ACTIVE' }
        }),
        prisma.user.findUnique({ where: { id: clientId } }),
        prisma.user.findUnique({ where: { id: readerId } })
      ]);

      if (!session || !client || !reader) {
        throw new Error('Session or users not found');
      }

      // Check if client has sufficient balance
      if (client.balance < ratePerMinute) {
        // End session due to insufficient funds
        await this.endSessionDueToInsufficientFunds(session);
        throw new Error('Insufficient balance to continue session');
      }

      // Calculate fees and earnings
      const amount = ratePerMinute;
      const platformFee = amount * this.platformFeeRate;
      const readerEarnings = amount * this.readerEarningsRate;

      // Execute all updates in a single database transaction
      const result = await executeTransaction([
        // Deduct from client balance
        prisma.user.update({
          where: { id: clientId },
          data: { balance: { decrement: amount } }
        }),

        // Add to reader earnings
        prisma.user.update({
          where: { id: readerId },
          data: {
            pendingEarnings: { increment: readerEarnings },
            totalEarnings: { increment: readerEarnings }
          }
        }),

        // Update session totals
        prisma.session.update({
          where: { id: session.id },
          data: {
            totalCost: { increment: amount },
            platformFee: { increment: platformFee },
            readerEarnings: { increment: readerEarnings }
          }
        }),

        // Create transaction record
        prisma.transaction.create({
          data: {
            userId: clientId,
            sessionId: session.id,
            type: 'CHARGE',
            amount: amount,
            currency: 'USD',
            status: 'SUCCEEDED',
            description: `Session charge - ${session.sessionType} reading`,
            platformFee: platformFee,
            stripeFee: 0, // No Stripe fee for balance deduction
            processedAt: new Date(),
            metadata: {
              sessionType: session.sessionType,
              readerId: readerId,
              ratePerMinute: ratePerMinute,
              billingType: 'per_minute'
            }
          }
        })
      ]);

      console.log(`Billing: Charged $${amount} for session ${sessionId}`);

      return {
        success: true,
        amount: amount,
        newBalance: result[0].balance,
        readerEarnings: readerEarnings,
        platformFee: platformFee
      };

    } catch (error) {
      console.error('Billing error:', error);
      throw handlePrismaError(error);
    }
  }

  // End session due to insufficient funds
  async endSessionDueToInsufficientFunds(session) {
    try {
      const endTime = new Date();
      const startTime = new Date(session.startTime);
      const duration = session.startTime ? Math.floor((endTime - startTime) / 1000) : 0;

      await prisma.session.update({
        where: { id: session.id },
        data: {
          status: 'ENDED',
          endTime,
          duration,
          adminNotes: 'Session ended due to insufficient client balance'
        }
      });

      console.log(`Billing: Session ${session.sessionId} ended due to insufficient funds`);

    } catch (error) {
      console.error('Error ending session due to insufficient funds:', error);
      throw handlePrismaError(error);
    }
  }

  // Process automatic payouts for readers
  async processAutomaticPayouts() {
    try {
      console.log('Processing automatic payouts...');

      // Find readers eligible for payout
      const eligibleReaders = await prisma.user.findMany({
        where: {
          role: 'READER',
          isActive: true,
          stripeAccountId: { not: null },
          pendingEarnings: { gte: this.minimumPayoutAmount }
        }
      });

      const results = [];

      for (const reader of eligibleReaders) {
        try {
          const payoutAmount = reader.pendingEarnings;

          // Create Stripe transfer
          const transfer = await stripe.transfers.create({
            amount: Math.round(payoutAmount * 100), // Convert to cents
            currency: 'usd',
            destination: reader.stripeAccountId,
            description: `Automatic payout for reader ${reader.email}`,
            metadata: {
              readerId: reader.id,
              payoutType: 'automatic'
            }
          });

          // Update reader earnings in transaction
          await executeTransaction([
            prisma.user.update({
              where: { id: reader.id },
              data: {
                pendingEarnings: 0,
                paidEarnings: { increment: payoutAmount },
                lastPayout: new Date()
              }
            }),

            prisma.transaction.create({
              data: {
                userId: reader.id,
                type: 'PAYOUT',
                amount: payoutAmount,
                currency: 'USD',
                status: 'SUCCEEDED',
                description: `Automatic payout - $${payoutAmount.toFixed(2)}`,
                stripeTransferId: transfer.id,
                processedAt: new Date(),
                metadata: {
                  payoutType: 'automatic',
                  stripeTransferId: transfer.id
                }
              }
            })
          ]);

          results.push({
            readerId: reader.id,
            email: reader.email,
            amount: payoutAmount,
            transferId: transfer.id,
            status: 'success'
          });

          console.log(`Payout processed: $${payoutAmount} to ${reader.email}`);

        } catch (error) {
          console.error(`Payout failed for reader ${reader.id}:`, error);
          
          results.push({
            readerId: reader.id,
            email: reader.email,
            amount: reader.pendingEarnings,
            status: 'failed',
            error: error.message
          });
        }
      }

      console.log(`Processed ${results.filter(r => r.status === 'success').length} successful payouts`);
      return results;

    } catch (error) {
      console.error('Automatic payout processing error:', error);
      throw handlePrismaError(error);
    }
  }

  // Add funds to client balance
  async addFundsToClient(clientId, amount, paymentIntentId) {
    try {
      const client = await prisma.user.findUnique({ where: { id: clientId } });
      if (!client) {
        throw new Error('Client not found');
      }

      const result = await executeTransaction([
        prisma.user.update({
          where: { id: clientId },
          data: { balance: { increment: amount } }
        }),

        prisma.transaction.create({
          data: {
            userId: clientId,
            type: 'DEPOSIT',
            amount: amount,
            currency: 'USD',
            status: 'SUCCEEDED',
            description: `Account balance deposit - $${amount.toFixed(2)}`,
            stripePaymentIntentId: paymentIntentId,
            processedAt: new Date(),
            metadata: {
              depositType: 'stripe_payment',
              paymentIntentId: paymentIntentId
            }
          }
        })
      ]);

      console.log(`Added $${amount} to client ${clientId} balance`);

      return {
        success: true,
        newBalance: result[0].balance,
        transaction: result[1]
      };

    } catch (error) {
      console.error('Add funds error:', error);
      throw handlePrismaError(error);
    }
  }

  // Get billing statistics
  async getBillingStatistics(startDate = null, endDate = null) {
    try {
      const dateFilter = {};
      if (startDate) dateFilter.gte = new Date(startDate);
      if (endDate) dateFilter.lte = new Date(endDate);

      const where = {
        status: 'SUCCEEDED',
        ...(Object.keys(dateFilter).length > 0 && { createdAt: dateFilter })
      };

      // Get transaction statistics by type
      const transactionStats = await prisma.transaction.groupBy({
        by: ['type'],
        where,
        _sum: { amount: true },
        _count: { id: true }
      });

      // Get session statistics
      const sessionStats = await prisma.session.aggregate({
        where: {
          status: 'ENDED',
          ...(Object.keys(dateFilter).length > 0 && { endTime: dateFilter })
        },
        _count: { id: true },
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
      });

      // Calculate totals
      const totalRevenue = transactionStats
        .filter(stat => stat.type === 'CHARGE')
        .reduce((sum, stat) => sum + (stat._sum.amount || 0), 0);

      const totalDeposits = transactionStats
        .filter(stat => stat.type === 'DEPOSIT')
        .reduce((sum, stat) => sum + (stat._sum.amount || 0), 0);

      const totalPayouts = transactionStats
        .filter(stat => stat.type === 'PAYOUT')
        .reduce((sum, stat) => sum + (stat._sum.amount || 0), 0);

      return {
        transactions: {
          totalRevenue,
          totalDeposits,
          totalPayouts,
          platformEarnings: sessionStats._sum.platformFee || 0,
          readerEarnings: sessionStats._sum.readerEarnings || 0
        },
        sessions: {
          totalSessions: sessionStats._count.id || 0,
          totalCost: sessionStats._sum.totalCost || 0,
          totalMinutes: Math.floor((sessionStats._sum.duration || 0) / 60),
          averageSessionCost: sessionStats._avg.totalCost || 0,
          averageSessionDuration: Math.floor((sessionStats._avg.duration || 0) / 60),
          averageRating: sessionStats._avg.rating || 0
        },
        breakdown: transactionStats.map(stat => ({
          type: stat.type,
          amount: stat._sum.amount || 0,
          count: stat._count.id || 0
        }))
      };

    } catch (error) {
      console.error('Billing statistics error:', error);
      throw handlePrismaError(error);
    }
  }

  // Process refund for cancelled session
  async processRefund(sessionId, refundAmount, reason = 'Session cancelled') {
    try {
      const session = await prisma.session.findFirst({
        where: { sessionId },
        include: { client: true }
      });

      if (!session) {
        throw new Error('Session not found');
      }

      // Add refund to client balance
      await executeTransaction([
        prisma.user.update({
          where: { id: session.clientId },
          data: { balance: { increment: refundAmount } }
        }),

        prisma.transaction.create({
          data: {
            userId: session.clientId,
            sessionId: session.id,
            type: 'REFUND',
            amount: refundAmount,
            currency: 'USD',
            status: 'SUCCEEDED',
            description: reason,
            processedAt: new Date(),
            metadata: {
              originalSessionId: sessionId,
              refundReason: reason
            }
          }
        })
      ]);

      console.log(`Refunded $${refundAmount} for session ${sessionId}`);

      return {
        success: true,
        refundAmount,
        reason
      };

    } catch (error) {
      console.error('Refund processing error:', error);
      throw handlePrismaError(error);
    }
  }

  // Get reader earnings summary
  async getReaderEarningsSummary(readerId, period = '30d') {
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
        default:
          startDate.setDate(startDate.getDate() - 30);
      }

      // Get reader's current earnings
      const reader = await prisma.user.findUnique({
        where: { id: readerId },
        select: {
          pendingEarnings: true,
          paidEarnings: true,
          totalEarnings: true,
          lastPayout: true
        }
      });

      // Get period earnings from sessions
      const periodSessions = await prisma.session.findMany({
        where: {
          readerId,
          status: 'ENDED',
          endTime: { gte: startDate }
        },
        select: {
          readerEarnings: true,
          duration: true,
          sessionType: true,
          rating: true,
          endTime: true
        }
      });

      const periodEarnings = periodSessions.reduce((sum, s) => sum + (s.readerEarnings || 0), 0);
      const periodMinutes = periodSessions.reduce((sum, s) => sum + (s.duration || 0), 0) / 60;

      // Get today's earnings
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      
      const todaySessions = await prisma.session.findMany({
        where: {
          readerId,
          status: 'ENDED',
          endTime: { gte: todayStart }
        },
        select: { readerEarnings: true }
      });

      const todayEarnings = todaySessions.reduce((sum, s) => sum + (s.readerEarnings || 0), 0);

      return {
        current: {
          pending: reader.pendingEarnings || 0,
          paid: reader.paidEarnings || 0,
          total: reader.totalEarnings || 0,
          lastPayout: reader.lastPayout
        },
        period: {
          earnings: periodEarnings,
          sessions: periodSessions.length,
          minutes: Math.floor(periodMinutes),
          averagePerSession: periodSessions.length > 0 ? periodEarnings / periodSessions.length : 0
        },
        today: {
          earnings: todayEarnings,
          sessions: todaySessions.length
        }
      };

    } catch (error) {
      console.error('Reader earnings summary error:', error);
      throw handlePrismaError(error);
    }
  }
}

module.exports = BillingManager;