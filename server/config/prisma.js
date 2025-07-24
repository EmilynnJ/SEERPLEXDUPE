const { PrismaClient } = require('@prisma/client');

let prisma;
if (process.env.NODE_ENV === 'production') {
  prisma = new PrismaClient({
    datasources: {
      db: {
        url: process.env.DATABASE_URL,
      },
    },
    log: ['query', 'info', 'warn', 'error'],
  });
} else {
  // In development, use a global variable to preserve the PrismaClient instance across module reloads
  if (!global.prisma) {
    global.prisma = new PrismaClient({
      log: ['query', 'info', 'warn', 'error'],
    });
  }
  prisma = global.prisma;
}

const connectDB = async () => {
  try {
    await prisma.$connect();
    console.log('Prisma Client connected to the database');

    // Listen for any unknown request errors
    prisma.$on('error', (e) => {
      console.error('Prisma Client connection error:', e);
    });
  } catch (error) {
    console.error('Database connection error:', error);
    process.exit(1);
  }
};

// Graceful shutdown handler
const shutdown = async () => {
  try {
    await prisma.$disconnect();
    console.log('Prisma Client disconnected gracefully');
  } catch (e) {
    console.error('Error during Prisma Client shutdown:', e);
  } finally {
    process.exit(0);
  }
};

// Handle termination signals
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('beforeExit', async () => {
  await prisma.$disconnect();
});

module.exports = { connectDB, prisma };