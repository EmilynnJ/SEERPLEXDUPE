const mongoose = require('mongoose');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// Initialize clients
const prisma = new PrismaClient();

// MongoDB Models (for reading data)
const User = require('../server/models/User');
const Session = require('../server/models/Session');
const Message = require('../server/models/Message');
const Transaction = require('../server/models/Transaction');

class DataMigrator {
  constructor() {
    this.migrationLog = [];
    this.errors = [];
    this.idMappings = {
      users: new Map(),
      sessions: new Map(),
      messages: new Map(),
      transactions: new Map()
    };
    this.rollbackData = {
      users: [],
      sessions: [],
      messages: [],
      transactions: [],
      reactions: [],
      bookings: []
    };
  }

  log(message, type = 'info') {
    const timestamp = new Date().toISOString();
    const logEntry = { timestamp, message, type };
    this.migrationLog.push(logEntry);
    console.log(`[${timestamp}] ${type.toUpperCase()}: ${message}`);
  }

  error(message, error = null) {
    const timestamp = new Date().toISOString();
    const errorEntry = { timestamp, message, error: error?.message || error, type: 'error' };
    this.errors.push(errorEntry);
    console.error(`[${timestamp}] ERROR: ${message}`, error);
  }

  // Connect to MongoDB
  async connectMongoDB() {
    try {
      await mongoose.connect(process.env.MONGODB_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
      });
      this.log('Connected to MongoDB');
    } catch (error) {
      this.error('Failed to connect to MongoDB', error);
      throw error;
    }
  }

  // Disconnect from MongoDB
  async disconnectMongoDB() {
    try {
      await mongoose.disconnect();
      this.log('Disconnected from MongoDB');
    } catch (error) {
      this.error('Failed to disconnect from MongoDB', error);
    }
  }

  // Connect to PostgreSQL via Prisma
  async connectPostgreSQL() {
    try {
      await prisma.$connect();
      this.log('Connected to PostgreSQL via Prisma');
    } catch (error) {
      this.error('Failed to connect to PostgreSQL', error);
      throw error;
    }
  }

  // Disconnect from PostgreSQL
  async disconnectPostgreSQL() {
    try {
      await prisma.$disconnect();
      this.log('Disconnected from PostgreSQL');
    } catch (error) {
      this.error('Failed to disconnect from PostgreSQL', error);
    }
  }

  // Generate UUID for new records
  generateUUID() {
    return uuidv4();
  }

  // Convert MongoDB ObjectId to UUID and store mapping
  mapObjectIdToUUID(objectId, type) {
    const objectIdStr = objectId.toString();
    if (!this.idMappings[type].has(objectIdStr)) {
      this.idMappings[type].set(objectIdStr, this.generateUUID());
    }
    return this.idMappings[type].get(objectIdStr);
  }

  // Validate user data
  validateUserData(user) {
    const errors = [];
    
    if (!user.email || typeof user.email !== 'string') {
      errors.push('Invalid email');
    }
    
    if (!user.password || typeof user.password !== 'string') {
      errors.push('Invalid password');
    }
    
    if (!['client', 'reader', 'admin'].includes(user.role)) {
      errors.push('Invalid role');
    }

    return errors;
  }

  // Transform user data from MongoDB to PostgreSQL format
  transformUserData(mongoUser) {
    const uuid = this.mapObjectIdToUUID(mongoUser._id, 'users');
    
    return {
      id: uuid,
      email: mongoUser.email.toLowerCase().trim(),
      password: mongoUser.password,
      role: mongoUser.role.toUpperCase(),
      
      // Profile information
      name: mongoUser.profile?.name || null,
      avatar: mongoUser.profile?.avatar || null,
      bio: mongoUser.profile?.bio || null,
      specialties: mongoUser.profile?.specialties || [],
      rating: mongoUser.profile?.rating || 0,
      totalReviews: mongoUser.profile?.totalReviews || 0,
      totalRating: mongoUser.profile?.totalRating || 0,
      
      // Reader settings
      isOnline: mongoUser.readerSettings?.isOnline || false,
      videoRate: mongoUser.readerSettings?.rates?.video || 3.99,
      audioRate: mongoUser.readerSettings?.rates?.audio || 2.99,
      chatRate: mongoUser.readerSettings?.rates?.chat || 1.99,
      availability: mongoUser.readerSettings?.availability ? JSON.stringify(mongoUser.readerSettings.availability) : null,
      autoAcceptSessions: mongoUser.readerSettings?.autoAcceptSessions || false,
      
      // Financial information
      balance: mongoUser.balance || 0,
      totalEarnings: mongoUser.earnings?.total || 0,
      pendingEarnings: mongoUser.earnings?.pending || 0,
      paidEarnings: mongoUser.earnings?.paid || 0,
      lastPayout: mongoUser.earnings?.lastPayout || null,
      
      // Stripe integration
      stripeCustomerId: mongoUser.stripeCustomerId || null,
      stripeAccountId: mongoUser.stripeAccountId || null,
      
      // Status and verification
      isVerified: mongoUser.isVerified || false,
      isActive: mongoUser.isActive !== false, // Default to true if undefined
      lastSeen: mongoUser.lastSeen || mongoUser.createdAt || new Date(),
      
      // Preferences
      preferences: mongoUser.preferences ? JSON.stringify(mongoUser.preferences) : null,
      
      // Timestamps
      createdAt: mongoUser.createdAt || new Date(),
      updatedAt: mongoUser.updatedAt || new Date()
    };
  }

  // Transform session data
  transformSessionData(mongoSession) {
    const uuid = this.mapObjectIdToUUID(mongoSession._id, 'sessions');
    const clientUUID = this.idMappings.users.get(mongoSession.clientId.toString());
    const readerUUID = this.idMappings.users.get(mongoSession.readerId.toString());

    if (!clientUUID || !readerUUID) {
      throw new Error(`Missing user mapping for session ${mongoSession._id}`);
    }

    return {
      id: uuid,
      sessionId: mongoSession.sessionId,
      clientId: clientUUID,
      readerId: readerUUID,
      sessionType: mongoSession.sessionType.toUpperCase(),
      status: mongoSession.status.toUpperCase(),
      
      // Timing
      startTime: mongoSession.startTime || null,
      endTime: mongoSession.endTime || null,
      duration: mongoSession.duration || 0,
      
      // Financial
      rate: mongoSession.rate,
      totalCost: mongoSession.totalCost || 0,
      platformFee: mongoSession.platformFee || 0,
      readerEarnings: mongoSession.readerEarnings || 0,
      billingHistory: mongoSession.billingHistory ? JSON.stringify(mongoSession.billingHistory) : null,
      
      // Review and feedback
      rating: mongoSession.rating || null,
      review: mongoSession.review || null,
      readerResponse: mongoSession.readerResponse || null,
      
      // Notes
      clientNotes: mongoSession.notes?.client || null,
      readerNotes: mongoSession.notes?.reader || null,
      adminNotes: mongoSession.notes?.admin || null,
      
      // Metadata
      metadata: mongoSession.metadata ? JSON.stringify(mongoSession.metadata) : null,
      
      // Flags
      disputed: mongoSession.flags?.disputed || false,
      refunded: mongoSession.flags?.refunded || false,
      technicalIssues: mongoSession.flags?.technical_issues || false,
      
      // Timestamps
      createdAt: mongoSession.createdAt || new Date(),
      updatedAt: mongoSession.updatedAt || new Date()
    };
  }

  // Transform message data
  transformMessageData(mongoMessage) {
    const uuid = this.mapObjectIdToUUID(mongoMessage._id, 'messages');
    const senderUUID = this.idMappings.users.get(mongoMessage.senderId.toString());
    const receiverUUID = this.idMappings.users.get(mongoMessage.receiverId.toString());

    if (!senderUUID || !receiverUUID) {
      throw new Error(`Missing user mapping for message ${mongoMessage._id}`);
    }

    const sessionUUID = mongoMessage.sessionId ? 
      this.idMappings.sessions.get(mongoMessage.sessionId.toString()) : null;
    
    const replyToUUID = mongoMessage.replyTo ? 
      this.idMappings.messages.get(mongoMessage.replyTo.toString()) : null;
    
    const deletedByUUID = mongoMessage.deletedBy ? 
      this.idMappings.users.get(mongoMessage.deletedBy.toString()) : null;

    return {
      id: uuid,
      senderId: senderUUID,
      receiverId: receiverUUID,
      sessionId: sessionUUID,
      conversationId: mongoMessage.conversationId,
      content: mongoMessage.content,
      messageType: mongoMessage.messageType.toUpperCase(),
      
      // Attachments
      attachments: mongoMessage.attachments ? JSON.stringify(mongoMessage.attachments) : null,
      
      // Status
      isRead: mongoMessage.isRead || false,
      readAt: mongoMessage.readAt || null,
      isEdited: mongoMessage.isEdited || false,
      editedAt: mongoMessage.editedAt || null,
      originalContent: mongoMessage.originalContent || null,
      isDeleted: mongoMessage.isDeleted || false,
      deletedAt: mongoMessage.deletedAt || null,
      deletedBy: deletedByUUID,
      
      // Reply functionality
      replyToId: replyToUUID,
      
      // Metadata
      metadata: mongoMessage.metadata ? JSON.stringify(mongoMessage.metadata) : null,
      
      // Timestamps
      createdAt: mongoMessage.createdAt || new Date(),
      updatedAt: mongoMessage.updatedAt || new Date()
    };
  }

  // Transform reaction data
  transformReactionData(mongoMessage) {
    const reactions = [];
    const messageUUID = this.idMappings.messages.get(mongoMessage._id.toString());

    if (mongoMessage.reactions && mongoMessage.reactions.length > 0) {
      for (const reaction of mongoMessage.reactions) {
        const userUUID = this.idMappings.users.get(reaction.userId.toString());
        if (userUUID) {
          reactions.push({
            id: this.generateUUID(),
            messageId: messageUUID,
            userId: userUUID,
            emoji: reaction.emoji,
            createdAt: reaction.createdAt || new Date()
          });
        }
      }
    }

    return reactions;
  }

  // Transform transaction data
  transformTransactionData(mongoTransaction) {
    const uuid = this.mapObjectIdToUUID(mongoTransaction._id, 'transactions');
    const userUUID = this.idMappings.users.get(mongoTransaction.userId.toString());

    if (!userUUID) {
      throw new Error(`Missing user mapping for transaction ${mongoTransaction._id}`);
    }

    const sessionUUID = mongoTransaction.sessionId ? 
      this.idMappings.sessions.get(mongoTransaction.sessionId.toString()) : null;

    return {
      id: uuid,
      userId: userUUID,
      sessionId: sessionUUID,
      type: mongoTransaction.type.toUpperCase(),
      amount: mongoTransaction.amount,
      currency: mongoTransaction.currency || 'USD',
      
      // Stripe integration
      stripePaymentIntentId: mongoTransaction.stripePaymentIntentId || null,
      stripeTransferId: mongoTransaction.stripeTransferId || null,
      stripeChargeId: mongoTransaction.stripeChargeId || null,
      
      // Status and processing
      status: mongoTransaction.status.toUpperCase(),
      description: mongoTransaction.description,
      processedAt: mongoTransaction.processedAt || null,
      failureReason: mongoTransaction.failureReason || null,
      retryCount: mongoTransaction.retryCount || 0,
      
      // Balance tracking
      balanceBefore: mongoTransaction.balanceBefore || null,
      balanceAfter: mongoTransaction.balanceAfter || null,
      
      // Fees
      stripeFee: mongoTransaction.fees?.stripeFee || 0,
      platformFee: mongoTransaction.fees?.platformFee || 0,
      totalFees: mongoTransaction.fees?.totalFees || 0,
      
      // Metadata
      metadata: mongoTransaction.metadata ? JSON.stringify(mongoTransaction.metadata) : null,
      
      // Timestamps
      createdAt: mongoTransaction.createdAt || new Date(),
      updatedAt: mongoTransaction.updatedAt || new Date()
    };
  }

  // Migrate users
  async migrateUsers() {
    this.log('Starting user migration...');
    
    try {
      const mongoUsers = await User.find({}).lean();
      this.log(`Found ${mongoUsers.length} users to migrate`);

      const batchSize = 100;
      let migratedCount = 0;
      let errorCount = 0;

      for (let i = 0; i < mongoUsers.length; i += batchSize) {
        const batch = mongoUsers.slice(i, i + batchSize);
        const transformedUsers = [];

        for (const mongoUser of batch) {
          try {
            const validationErrors = this.validateUserData(mongoUser);
            if (validationErrors.length > 0) {
              this.error(`User validation failed for ${mongoUser._id}: ${validationErrors.join(', ')}`);
              errorCount++;
              continue;
            }

            const transformedUser = this.transformUserData(mongoUser);
            transformedUsers.push(transformedUser);
            this.rollbackData.users.push(transformedUser.id);
          } catch (error) {
            this.error(`Failed to transform user ${mongoUser._id}`, error);
            errorCount++;
          }
        }

        if (transformedUsers.length > 0) {
          try {
            await prisma.user.createMany({
              data: transformedUsers,
              skipDuplicates: true
            });
            migratedCount += transformedUsers.length;
            this.log(`Migrated batch of ${transformedUsers.length} users (${migratedCount}/${mongoUsers.length})`);
          } catch (error) {
            this.error(`Failed to insert user batch`, error);
            errorCount += transformedUsers.length;
          }
        }
      }

      this.log(`User migration completed: ${migratedCount} migrated, ${errorCount} errors`);
      return { migrated: migratedCount, errors: errorCount };
    } catch (error) {
      this.error('User migration failed', error);
      throw error;
    }
  }

  // Migrate sessions
  async migrateSessions() {
    this.log('Starting session migration...');
    
    try {
      const mongoSessions = await Session.find({}).lean();
      this.log(`Found ${mongoSessions.length} sessions to migrate`);

      const batchSize = 100;
      let migratedCount = 0;
      let errorCount = 0;

      for (let i = 0; i < mongoSessions.length; i += batchSize) {
        const batch = mongoSessions.slice(i, i + batchSize);
        const transformedSessions = [];

        for (const mongoSession of batch) {
          try {
            const transformedSession = this.transformSessionData(mongoSession);
            transformedSessions.push(transformedSession);
            this.rollbackData.sessions.push(transformedSession.id);
          } catch (error) {
            this.error(`Failed to transform session ${mongoSession._id}`, error);
            errorCount++;
          }
        }

        if (transformedSessions.length > 0) {
          try {
            await prisma.session.createMany({
              data: transformedSessions,
              skipDuplicates: true
            });
            migratedCount += transformedSessions.length;
            this.log(`Migrated batch of ${transformedSessions.length} sessions (${migratedCount}/${mongoSessions.length})`);
          } catch (error) {
            this.error(`Failed to insert session batch`, error);
            errorCount += transformedSessions.length;
          }
        }
      }

      this.log(`Session migration completed: ${migratedCount} migrated, ${errorCount} errors`);
      return { migrated: migratedCount, errors: errorCount };
    } catch (error) {
      this.error('Session migration failed', error);
      throw error;
    }
  }

  // Migrate messages and reactions
  async migrateMessages() {
    this.log('Starting message migration...');
    
    try {
      const mongoMessages = await Message.find({}).lean();
      this.log(`Found ${mongoMessages.length} messages to migrate`);

      const batchSize = 100;
      let migratedCount = 0;
      let errorCount = 0;
      let reactionCount = 0;

      for (let i = 0; i < mongoMessages.length; i += batchSize) {
        const batch = mongoMessages.slice(i, i + batchSize);
        const transformedMessages = [];
        const allReactions = [];

        for (const mongoMessage of batch) {
          try {
            const transformedMessage = this.transformMessageData(mongoMessage);
            transformedMessages.push(transformedMessage);
            this.rollbackData.messages.push(transformedMessage.id);

            // Extract reactions
            const reactions = this.transformReactionData(mongoMessage);
            allReactions.push(...reactions);
          } catch (error) {
            this.error(`Failed to transform message ${mongoMessage._id}`, error);
            errorCount++;
          }
        }

        if (transformedMessages.length > 0) {
          try {
            await prisma.message.createMany({
              data: transformedMessages,
              skipDuplicates: true
            });
            migratedCount += transformedMessages.length;

            // Insert reactions
            if (allReactions.length > 0) {
              await prisma.reaction.createMany({
                data: allReactions,
                skipDuplicates: true
              });
              reactionCount += allReactions.length;
              this.rollbackData.reactions.push(...allReactions.map(r => r.id));
            }

            this.log(`Migrated batch of ${transformedMessages.length} messages and ${allReactions.length} reactions (${migratedCount}/${mongoMessages.length})`);
          } catch (error) {
            this.error(`Failed to insert message batch`, error);
            errorCount += transformedMessages.length;
          }
        }
      }

      this.log(`Message migration completed: ${migratedCount} messages and ${reactionCount} reactions migrated, ${errorCount} errors`);
      return { migrated: migratedCount, reactions: reactionCount, errors: errorCount };
    } catch (error) {
      this.error('Message migration failed', error);
      throw error;
    }
  }

  // Migrate transactions
  async migrateTransactions() {
    this.log('Starting transaction migration...');
    
    try {
      const mongoTransactions = await Transaction.find({}).lean();
      this.log(`Found ${mongoTransactions.length} transactions to migrate`);

      const batchSize = 100;
      let migratedCount = 0;
      let errorCount = 0;

      for (let i = 0; i < mongoTransactions.length; i += batchSize) {
        const batch = mongoTransactions.slice(i, i + batchSize);
        const transformedTransactions = [];

        for (const mongoTransaction of batch) {
          try {
            const transformedTransaction = this.transformTransactionData(mongoTransaction);
            transformedTransactions.push(transformedTransaction);
            this.rollbackData.transactions.push(transformedTransaction.id);
          } catch (error) {
            this.error(`Failed to transform transaction ${mongoTransaction._id}`, error);
            errorCount++;
          }
        }

        if (transformedTransactions.length > 0) {
          try {
            await prisma.transaction.createMany({
              data: transformedTransactions,
              skipDuplicates: true
            });
            migratedCount += transformedTransactions.length;
            this.log(`Migrated batch of ${transformedTransactions.length} transactions (${migratedCount}/${mongoTransactions.length})`);
          } catch (error) {
            this.error(`Failed to insert transaction batch`, error);
            errorCount += transformedTransactions.length;
          }
        }
      }

      this.log(`Transaction migration completed: ${migratedCount} migrated, ${errorCount} errors`);
      return { migrated: migratedCount, errors: errorCount };
    } catch (error) {
      this.error('Transaction migration failed', error);
      throw error;
    }
  }

  // Validate migrated data
  async validateMigration() {
    this.log('Starting migration validation...');
    
    try {
      const [userCount, sessionCount, messageCount, transactionCount, reactionCount] = await Promise.all([
        prisma.user.count(),
        prisma.session.count(),
        prisma.message.count(),
        prisma.transaction.count(),
        prisma.reaction.count()
      ]);

      const [mongoUserCount, mongoSessionCount, mongoMessageCount, mongoTransactionCount] = await Promise.all([
        User.countDocuments(),
        Session.countDocuments(),
        Message.countDocuments(),
        Transaction.countDocuments()
      ]);

      this.log(`Validation results:`);
      this.log(`Users: MongoDB=${mongoUserCount}, PostgreSQL=${userCount}`);
      this.log(`Sessions: MongoDB=${mongoSessionCount}, PostgreSQL=${sessionCount}`);
      this.log(`Messages: MongoDB=${mongoMessageCount}, PostgreSQL=${messageCount}`);
      this.log(`Transactions: MongoDB=${mongoTransactionCount}, PostgreSQL=${transactionCount}`);
      this.log(`Reactions: PostgreSQL=${reactionCount}`);

      // Check for referential integrity
      const orphanedSessions = await prisma.session.count({
        where: {
          OR: [
            { client: null },
            { reader: null }
          ]
        }
      });

      const orphanedMessages = await prisma.message.count({
        where: {
          OR: [
            { sender: null },
            { receiver: null }
          ]
        }
      });

      const orphanedTransactions = await prisma.transaction.count({
        where: {
          user: null
        }
      });

      if (orphanedSessions > 0 || orphanedMessages > 0 || orphanedTransactions > 0) {
        this.error(`Referential integrity issues found: ${orphanedSessions} orphaned sessions, ${orphanedMessages} orphaned messages, ${orphanedTransactions} orphaned transactions`);
      } else {
        this.log('Referential integrity validation passed');
      }

      return {
        counts: {
          users: { mongo: mongoUserCount, postgres: userCount },
          sessions: { mongo: mongoSessionCount, postgres: sessionCount },
          messages: { mongo: mongoMessageCount, postgres: messageCount },
          transactions: { mongo: mongoTransactionCount, postgres: transactionCount },
          reactions: { postgres: reactionCount }
        },
        orphaned: {
          sessions: orphanedSessions,
          messages: orphanedMessages,
          transactions: orphanedTransactions
        }
      };
    } catch (error) {
      this.error('Migration validation failed', error);
      throw error;
    }
  }

  // Rollback migration
  async rollback() {
    this.log('Starting migration rollback...');
    
    try {
      // Delete in reverse order to maintain referential integrity
      if (this.rollbackData.reactions.length > 0) {
        await prisma.reaction.deleteMany({
          where: { id: { in: this.rollbackData.reactions } }
        });
        this.log(`Rolled back ${this.rollbackData.reactions.length} reactions`);
      }

      if (this.rollbackData.transactions.length > 0) {
        await prisma.transaction.deleteMany({
          where: { id: { in: this.rollbackData.transactions } }
        });
        this.log(`Rolled back ${this.rollbackData.transactions.length} transactions`);
      }

      if (this.rollbackData.messages.length > 0) {
        await prisma.message.deleteMany({
          where: { id: { in: this.rollbackData.messages } }
        });
        this.log(`Rolled back ${this.rollbackData.messages.length} messages`);
      }

      if (this.rollbackData.sessions.length > 0) {
        await prisma.session.deleteMany({
          where: { id: { in: this.rollbackData.sessions } }
        });
        this.log(`Rolled back ${this.rollbackData.sessions.length} sessions`);
      }

      if (this.rollbackData.users.length > 0) {
        await prisma.user.deleteMany({
          where: { id: { in: this.rollbackData.users } }
        });
        this.log(`Rolled back ${this.rollbackData.users.length} users`);
      }

      this.log('Migration rollback completed successfully');
    } catch (error) {
      this.error('Migration rollback failed', error);
      throw error;
    }
  }

  // Generate migration report
  generateReport() {
    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        totalLogs: this.migrationLog.length,
        totalErrors: this.errors.length,
        idMappings: {
          users: this.idMappings.users.size,
          sessions: this.idMappings.sessions.size,
          messages: this.idMappings.messages.size,
          transactions: this.idMappings.transactions.size
        }
      },
      logs: this.migrationLog,
      errors: this.errors
    };

    return report;
  }

  // Main migration method
  async migrate(options = {}) {
    const { dryRun = false, validateOnly = false } = options;
    
    try {
      this.log(`Starting data migration${dryRun ? ' (DRY RUN)' : ''}...`);
      
      // Connect to databases
      await this.connectMongoDB();
      await this.connectPostgreSQL();

      if (validateOnly) {
        const validation = await this.validateMigration();
        return { validation, report: this.generateReport() };
      }

      if (dryRun) {
        this.log('DRY RUN: Simulating migration without actual data transfer');
        
        // Count records for dry run
        const [userCount, sessionCount, messageCount, transactionCount] = await Promise.all([
          User.countDocuments(),
          Session.countDocuments(),
          Message.countDocuments(),
          Transaction.countDocuments()
        ]);

        this.log(`DRY RUN: Would migrate ${userCount} users, ${sessionCount} sessions, ${messageCount} messages, ${transactionCount} transactions`);
        
        return { 
          dryRun: true, 
          counts: { userCount, sessionCount, messageCount, transactionCount },
          report: this.generateReport() 
        };
      }

      // Perform actual migration
      const userResult = await this.migrateUsers();
      const sessionResult = await this.migrateSessions();
      const messageResult = await this.migrateMessages();
      const transactionResult = await this.migrateTransactions();

      // Validate migration
      const validation = await this.validateMigration();

      this.log('Migration completed successfully!');

      return {
        success: true,
        results: {
          users: userResult,
          sessions: sessionResult,
          messages: messageResult,
          transactions: transactionResult
        },
        validation,
        report: this.generateReport()
      };

    } catch (error) {
      this.error('Migration failed', error);
      
      // Attempt rollback if not a dry run
      if (!dryRun && !validateOnly) {
        try {
          await this.rollback();
        } catch (rollbackError) {
          this.error('Rollback also failed', rollbackError);
        }
      }

      return {
        success: false,
        error: error.message,
        report: this.generateReport()
      };
    } finally {
      // Cleanup connections
      await this.disconnectMongoDB();
      await this.disconnectPostgreSQL();
    }
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const validateOnly = args.includes('--validate-only');
  const help = args.includes('--help') || args.includes('-h');

  if (help) {
    console.log(`
Data Migration Script - MongoDB to PostgreSQL

Usage: node migrate-data.js [options]

Options:
  --dry-run        Simulate migration without transferring data
  --validate-only  Only validate existing migrated data
  --help, -h       Show this help message

Examples:
  node migrate-data.js --dry-run
  node migrate-data.js --validate-only
  node migrate-data.js
    `);
    process.exit(0);
  }

  const migrator = new DataMigrator();
  
  try {
    const result = await migrator.migrate({ dryRun, validateOnly });
    
    if (result.success) {
      console.log('\n✅ Migration completed successfully!');
      if (result.validation) {
        console.log('\n📊 Validation Summary:');
        console.log(JSON.stringify(result.validation.counts, null, 2));
      }
    } else {
      console.log('\n❌ Migration failed!');
      console.log('Error:', result.error);
    }

    // Save report to file
    const fs = require('fs');
    const reportPath = `migration-report-${Date.now()}.json`;
    fs.writeFileSync(reportPath, JSON.stringify(result.report, null, 2));
    console.log(`\n📄 Migration report saved to: ${reportPath}`);

    process.exit(result.success ? 0 : 1);
  } catch (error) {
    console.error('\n💥 Unexpected error:', error);
    process.exit(1);
  }
}

// Export for use as module
module.exports = DataMigrator;

// Run if called directly
if (require.main === module) {
  main();
}