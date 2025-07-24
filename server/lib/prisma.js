const { PrismaClient, Prisma } = require('@prisma/client');

// Global variable to store the Prisma instance in development
// This prevents multiple instances during hot reloads
let prisma;

// Singleton pattern for Prisma Client
function createPrismaClient() {
  if (prisma) {
    return prisma;
  }

  // Configuration for Neon PostgreSQL with connection pooling
  const prismaConfig = {
    log: process.env.NODE_ENV === 'development'
      ? ['query', 'info', 'warn', 'error']
      : ['error'],
    errorFormat: 'pretty',
    datasources: {
      db: {
        url: process.env.DATABASE_URL
      }
    }
  };

  prisma = new PrismaClient(prismaConfig);

  // Store in global for development hot reloading
  if (process.env.NODE_ENV === 'development') {
    global.__prisma = prisma;
  }

  return prisma;
}

// Initialize Prisma Client
if (process.env.NODE_ENV === 'development' && global.__prisma) {
  prisma = global.__prisma;
} else {
  prisma = createPrismaClient();
}

// Error handling utility
function handlePrismaError(error) {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    switch (error.code) {
      case 'P2002':
        throw new Error(`Unique constraint failed: ${error.meta?.target || 'unknown field'}`);
      case 'P2025':
        throw new Error('Record not found');
      case 'P2003':
        throw new Error('Foreign key constraint failed');
      case 'P2014':
        throw new Error('Invalid ID provided');
      default:
        throw new Error(`Database error: ${error.message}`);
    }
  } else if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    throw new Error('Unknown database error occurred');
  } else if (error instanceof Prisma.PrismaClientRustPanicError) {
    throw new Error('Database engine error');
  } else if (error instanceof Prisma.PrismaClientInitializationError) {
    throw new Error('Failed to initialize database connection');
  } else if (error instanceof Prisma.PrismaClientValidationError) {
    throw new Error(`Validation error: ${error.message}`);
  }

  throw error;
}

// User helpers
const userHelpers = {
  async findByEmail(email) {
    try {
      return await prisma.user.findUnique({
        where: { email }
      });
    } catch (error) {
      throw handlePrismaError(error);
    }
  },

  async findByClerkId(clerkId) {
    try {
      return await prisma.user.findUnique({
        where: { clerkId }
      });
    } catch (error) {
      throw handlePrismaError(error);
    }
  },

  async createUser(userData) {
    try {
      return await prisma.user.create({
        data: userData
      });
    } catch (error) {
      throw handlePrismaError(error);
    }
  },

  async updateUser(id, updateData) {
    try {
      return await prisma.user.update({
        where: { id },
        data: updateData
      });
    } catch (error) {
      throw handlePrismaError(error);
    }
  },

  async updateLastSeen(id) {
    try {
      return await prisma.user.update({
        where: { id },
        data: { lastSeen: new Date() }
      });
    } catch (error) {
      throw handlePrismaError(error);
    }
  },

  async getReaders(filters = {}) {
    try {
      const where = {
        role: 'READER',
        isActive: true,
        ...filters
      };

      return await prisma.user.findMany({
        where,
        include: {
          readerSessions: {
            where: { status: 'ENDED' },
            select: {
              rating: true,
              totalCost: true,
              duration: true
            }
          }
        }
      });
    } catch (error) {
      throw handlePrismaError(error);
    }
  }
};

// Session helpers
const sessionHelpers = {
  async createSession(sessionData) {
    try {
      return await prisma.session.create({
        data: sessionData,
        include: {
          client: true,
          reader: true
        }
      });
    } catch (error) {
      throw handlePrismaError(error);
    }
  },

  async updateSession(id, updateData) {
    try {
      return await prisma.session.update({
        where: { id },
        data: updateData,
        include: {
          client: true,
          reader: true
        }
      });
    } catch (error) {
      throw handlePrismaError(error);
    }
  },

  async findActiveSession(userId) {
    try {
      return await prisma.session.findFirst({
        where: {
          OR: [
            { clientId: userId },
            { readerId: userId }
          ],
          status: 'ACTIVE'
        },
        include: {
          client: true,
          reader: true
        }
      });
    } catch (error) {
      throw handlePrismaError(error);
    }
  },

  async getUserSessions(userId, limit = 10) {
    try {
      return await prisma.session.findMany({
        where: {
          OR: [
            { clientId: userId },
            { readerId: userId }
          ]
        },
        include: {
          client: true,
          reader: true
        },
        orderBy: { createdAt: 'desc' },
        take: limit
      });
    } catch (error) {
      throw handlePrismaError(error);
    }
  }
};

// Transaction helpers
const transactionHelpers = {
  async createTransaction(transactionData) {
    try {
      return await prisma.transaction.create({
        data: transactionData,
        include: {
          user: true,
          session: true
        }
      });
    } catch (error) {
      throw handlePrismaError(error);
    }
  },

  async getUserTransactions(userId, limit = 20) {
    try {
      return await prisma.transaction.findMany({
        where: { userId },
        include: {
          session: true
        },
        orderBy: { createdAt: 'desc' },
        take: limit
      });
    } catch (error) {
      throw handlePrismaError(error);
    }
  },

  async getReaderEarnings(readerId, startDate, endDate) {
    try {
      const where = {
        userId: readerId,
        type: 'CHARGE',
        status: 'SUCCEEDED'
      };

      if (startDate) {
        where.createdAt = { gte: startDate };
      }

      if (endDate) {
        where.createdAt = { ...where.createdAt, lte: endDate };
      }

      const earnings = await prisma.transaction.aggregate({
        where,
        _sum: {
          amount: true
        }
      });

      return earnings._sum.amount || 0;
    } catch (error) {
      throw handlePrismaError(error);
    }
  }
};

// Message helpers
const messageHelpers = {
  async createMessage(messageData) {
    try {
      return await prisma.message.create({
        data: messageData,
        include: {
          sender: true,
          receiver: true
        }
      });
    } catch (error) {
      throw handlePrismaError(error);
    }
  },

  async getConversation(conversationId, limit = 50) {
    try {
      return await prisma.message.findMany({
        where: { conversationId },
        include: {
          sender: true,
          receiver: true
        },
        orderBy: { createdAt: 'asc' },
        take: limit
      });
    } catch (error) {
      throw handlePrismaError(error);
    }
  },

  async markAsRead(conversationId, userId) {
    try {
      return await prisma.message.updateMany({
        where: {
          conversationId,
          receiverId: userId,
          isRead: false
        },
        data: {
          isRead: true,
          readAt: new Date()
        }
      });
    } catch (error) {
      throw handlePrismaError(error);
    }
  },

  async getUnreadCount(userId) {
    try {
      return await prisma.message.count({
        where: {
          receiverId: userId,
          isRead: false
        }
      });
    } catch (error) {
      throw handlePrismaError(error);
    }
  }
};

// Database transaction wrapper
async function executeTransaction(operations) {
  try {
    return await prisma.$transaction(operations);
  } catch (error) {
    throw handlePrismaError(error);
  }
}

// Pagination helper
function createPaginationQuery(page = 1, limit = 20) {
  const skip = (page - 1) * limit;
  return {
    skip,
    take: limit
  };
}

// Connection health check
async function healthCheck() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: 'healthy', timestamp: new Date() };
  } catch (error) {
    return { status: 'unhealthy', error: error.message, timestamp: new Date() };
  }
}

// Graceful shutdown
async function disconnect() {
  try {
    await prisma.$disconnect();
    console.log('Prisma Client disconnected successfully');
  } catch (error) {
    console.error('Error disconnecting Prisma Client:', error);
    throw error;
  }
}

// Handle process termination
process.on('beforeExit', async () => {
  await disconnect();
});

process.on('SIGINT', async () => {
  await disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await disconnect();
  process.exit(0);
});

module.exports = {
  prisma,
  handlePrismaError,
  userHelpers,
  sessionHelpers,
  transactionHelpers,
  messageHelpers,
  executeTransaction,
  createPaginationQuery,
  healthCheck,
  disconnect
};