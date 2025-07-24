const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { prisma } = require('../lib/prisma');
const { authMiddleware, requireClient, requireReader } = require('../middleware/auth');
const { validatePaymentAmount } = require('../middleware/validation');

const router = express.Router();

// Create payment intent for balance top-up (clients only)
router.post('/create-payment-intent', authMiddleware, requireClient, validatePaymentAmount, async (req, res) => {
  try {
    const { amount } = req.body; // Amount in cents
    const userId = req.user.userId;

    // Retrieve user from database
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    let customerId = user.stripeCustomerId;

    // Create Stripe customer if doesn't exist
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: {
          userId: userId.toString(),
          role: user.role
        }
      });
      customerId = customer.id;

      // Update user with new Stripe customer ID
      await prisma.user.update({
        where: { id: userId },
        data: { stripeCustomerId: customerId }
      });
    }

    // Create payment intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      customer: customerId,
      automatic_payment_methods: {
        enabled: true,
      },
      metadata: {
        userId: userId.toString(),
        type: 'balance_topup',
        userEmail: user.email
      },
      description: `SoulSeer balance top-up for ${user.email}`
    });

    // Create pending transaction record
    const depositAmount = amount / 100; // Convert to dollars
    await prisma.transaction.create({
      data: {
        userId,
        type: 'deposit',
        amount: depositAmount,
        currency: 'USD',
        stripePaymentIntentId: paymentIntent.id,
        status: 'pending',
        description: `Balance top-up - $${depositAmount.toFixed(2)}`,
        balanceBefore: user.balance
      }
    });

    res.json({
      success: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amount: depositAmount
    });
  } catch (error) {
    console.error('Payment intent creation error:', error);
    res.status(500).json({
      message: 'Failed to create payment intent',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Confirm successful payment and update balance
router.post('/payment-success', authMiddleware, requireClient, async (req, res) => {
  try {
    const { paymentIntentId } = req.body;
    const userId = req.user.userId;

    if (!paymentIntentId) {
      return res.status(400).json({ message: 'Payment intent ID is required' });
    }

    // Retrieve payment intent from Stripe
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ message: 'Payment not successful' });
    }

    // Verify the payment belongs to this user
    if (paymentIntent.metadata.userId !== userId.toString()) {
      return res.status(403).json({ message: 'Payment does not belong to this user' });
    }

    // Find the transaction
    const transaction = await prisma.transaction.findFirst({
      where: {
        stripePaymentIntentId: paymentIntentId,
        userId
      }
    });
    if (!transaction) {
      return res.status(404).json({ message: 'Transaction not found' });
    }
    if (transaction.status === 'succeeded') {
      return res.status(400).json({ message: 'Payment already processed' });
    }

    // Update user balance atomically
    const addedAmount = paymentIntent.amount / 100; // Convert cents to dollars
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        balance: {
          increment: addedAmount
        }
      }
    });

    // Calculate Stripe fees (approximately 2.9% + 30¢)
    const stripeFee = Math.round((paymentIntent.amount * 0.029) + 30) / 100;

    // Update transaction record
    await prisma.transaction.update({
      where: { id: transaction.id },
      data: {
        status: 'succeeded',
        processedAt: new Date(),
        balanceAfter: updatedUser.balance,
        fees: {
          stripeFee: stripeFee,
          totalFees: stripeFee
        }
      }
    });

    res.json({
      success: true,
      message: 'Payment processed successfully',
      addedAmount,
      newBalance: updatedUser.balance,
      transactionId: transaction.id
    });
  } catch (error) {
    console.error('Payment confirmation error:', error);
    res.status(500).json({
      message: 'Failed to process payment confirmation',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Create Stripe Connect account for reader payouts
router.post('/create-connect-account', authMiddleware, requireReader, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Retrieve user from database
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    if (user.stripeAccountId) {
      return res.status(400).json({ message: 'Stripe account already exists' });
    }

    // Create Stripe Connect Express account
    const account = await stripe.accounts.create({
      type: 'express',
      country: 'US',
      email: user.email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true }
      },
      business_type: 'individual',
      metadata: {
        userId: userId.toString(),
        userEmail: user.email
      }
    });

    // Save account ID to user
    await prisma.user.update({
      where: { id: userId },
      data: { stripeAccountId: account.id }
    });

    // Create account link for onboarding
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: `${process.env.CLIENT_URL}/dashboard?setup=refresh`,
      return_url: `${process.env.CLIENT_URL}/dashboard?setup=complete`,
      type: 'account_onboarding'
    });

    res.json({
      success: true,
      accountId: account.id,
      onboardingUrl: accountLink.url
    });
  } catch (error) {
    console.error('Connect account creation error:', error);
    res.status(500).json({
      message: 'Failed to create Stripe Connect account',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get Stripe Connect account status
router.get('/connect-status', authMiddleware, requireReader, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Retrieve user from database
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });
    if (!user || !user.stripeAccountId) {
      return res.json({
        success: true,
        hasAccount: false,
        isComplete: false
      });
    }

    // Retrieve account from Stripe
    const account = await stripe.accounts.retrieve(user.stripeAccountId);
    const isComplete = account.details_submitted && account.charges_enabled && account.payouts_enabled;

    res.json({
      success: true,
      hasAccount: true,
      isComplete,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted
    });
  } catch (error) {
    console.error('Connect status error:', error);
    res.status(500).json({
      message: 'Failed to get Stripe Connect status',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Process reader payout
router.post('/payout', authMiddleware, requireReader, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Retrieve user from database
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    if (!user.stripeAccountId) {
      return res.status(400).json({ message: 'No Stripe Connect account found' });
    }

    const pendingEarnings = user.earnings.pending;
    const minimumPayout = 15.00; // $15 minimum
    if (pendingEarnings < minimumPayout) {
      return res.status(400).json({
        message: `Minimum payout amount is $${minimumPayout}`,
        currentPending: pendingEarnings,
        minimumRequired: minimumPayout
      });
    }

    // Check if Stripe account can receive payouts
    const account = await stripe.accounts.retrieve(user.stripeAccountId);
    if (!account.payouts_enabled) {
      return res.status(400).json({
        message: 'Stripe account setup incomplete. Please complete your account setup.',
        needsOnboarding: true
      });
    }

    // Create transfer to reader's Stripe account
    const transfer = await stripe.transfers.create({
      amount: Math.round(pendingEarnings * 100), // Convert to cents
      currency: 'usd',
      destination: user.stripeAccountId,
      metadata: {
        userId: userId.toString(),
        type: 'reader_payout'
      },
      description: `SoulSeer reader payout for ${user.email}`
    });

    // Update user earnings
    const updatedEarnings = {
      total: user.earnings.total,
      pending: 0,
      paid: user.earnings.paid + pendingEarnings,
      lastPayout: new Date()
    };
    await prisma.user.update({
      where: { id: userId },
      data: { earnings: updatedEarnings }
    });

    // Create transaction record
    await prisma.transaction.create({
      data: {
        userId,
        type: 'payout',
        amount: pendingEarnings,
        currency: 'USD',
        stripeTransferId: transfer.id,
        status: 'succeeded',
        description: `Reader payout - $${pendingEarnings.toFixed(2)}`,
        metadata: { automaticPayout: false }
      }
    });

    res.json({
      success: true,
      message: 'Payout processed successfully',
      amount: pendingEarnings,
      transferId: transfer.id,
      newPendingBalance: 0
    });
  } catch (error) {
    console.error('Payout error:', error);
    if (error.type === 'StripeCardError') {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({
      message: 'Failed to process payout',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Webhook endpoint for Stripe events
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // Handle the event
    switch (event.type) {
      case 'payment_intent.succeeded':
        await handlePaymentIntentSucceeded(event.data.object);
        break;
      case 'payment_intent.payment_failed':
        await handlePaymentIntentFailed(event.data.object);
        break;
      case 'transfer.created':
        console.log('Transfer created:', event.data.object.id);
        break;
      case 'transfer.failed':
        await handleTransferFailed(event.data.object);
        break;
      case 'account.updated':
        await handleAccountUpdated(event.data.object);
        break;
      default:
        console.log(`Unhandled event type ${event.type}`);
    }
    res.json({ received: true });
  } catch (error) {
    console.error('Webhook handler error:', error);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});

// Webhook handlers
async function handlePaymentIntentSucceeded(paymentIntent) {
  const transaction = await prisma.transaction.findFirst({
    where: { stripePaymentIntentId: paymentIntent.id }
  });
  if (transaction && transaction.status === 'pending') {
    const addedAmount = paymentIntent.amount / 100;
    const updatedUser = await prisma.user.update({
      where: { id: transaction.userId },
      data: { balance: { increment: addedAmount } }
    });
    await prisma.transaction.update({
      where: { id: transaction.id },
      data: {
        status: 'succeeded',
        processedAt: new Date(),
        balanceAfter: updatedUser.balance
      }
    });
    console.log(`Payment succeeded: $${addedAmount} added to user ${updatedUser.email}`);
  }
}

async function handlePaymentIntentFailed(paymentIntent) {
  const transaction = await prisma.transaction.findFirst({
    where: { stripePaymentIntentId: paymentIntent.id }
  });
  if (transaction) {
    await prisma.transaction.update({
      where: { id: transaction.id },
      data: {
        status: 'failed',
        failureReason: paymentIntent.last_payment_error?.message || 'Payment failed'
      }
    });
    console.log(`Payment failed for transaction ${transaction.id}`);
  }
}

async function handleTransferFailed(transfer) {
  const transaction = await prisma.transaction.findFirst({
    where: { stripeTransferId: transfer.id }
  });
  if (transaction) {
    const user = await prisma.user.findUnique({ where: { id: transaction.userId } });
    const restoredPending = user.earnings.pending + transaction.amount;
    const restoredPaid = user.earnings.paid - transaction.amount;
    await prisma.user.update({
      where: { id: transaction.userId },
      data: {
        earnings: {
          total: user.earnings.total,
          pending: restoredPending,
          paid: restoredPaid,
          lastPayout: user.earnings.lastPayout
        }
      }
    });
    await prisma.transaction.update({
      where: { id: transaction.id },
      data: {
        status: 'failed',
        failureReason: transfer.failure_message || 'Transfer failed'
      }
    });
    console.log(`Transfer failed: ${transfer.id}, restored $${transaction.amount} to user`);
  }
}

async function handleAccountUpdated(account) {
  const user = await prisma.user.findFirst({
    where: { stripeAccountId: account.id }
  });
  if (user) {
    const isComplete = account.details_submitted && account.charges_enabled && account.payouts_enabled;
    if (isComplete && !user.isVerified) {
      await prisma.user.update({
        where: { id: user.id },
        data: { isVerified: true }
      });
      console.log(`Reader account verified: ${user.email}`);
    }
  }
}

// Get payment methods for user
router.get('/payment-methods', authMiddleware, requireClient, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId }
    });
    if (!user || !user.stripeCustomerId) {
      return res.json({
        success: true,
        paymentMethods: []
      });
    }
    const paymentMethods = await stripe.paymentMethods.list({
      customer: user.stripeCustomerId,
      type: 'card'
    });
    const formattedMethods = paymentMethods.data.map(pm => ({
      id: pm.id,
      brand: pm.card.brand,
      last4: pm.card.last4,
      expMonth: pm.card.exp_month,
      expYear: pm.card.exp_year
    }));
    res.json({
      success: true,
      paymentMethods: formattedMethods
    });
  } catch (error) {
    console.error('Get payment methods error:', error);
    res.status(500).json({
      message: 'Failed to retrieve payment methods',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

module.exports = router;