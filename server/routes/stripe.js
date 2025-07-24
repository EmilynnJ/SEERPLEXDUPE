const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { prisma, executeTransaction, handlePrismaError } = require('../lib/prisma');
const { authMiddleware, requireClient, requireReader } = require('../middleware/auth');
const { validatePaymentAmount } = require('../middleware/validation');

const router = express.Router();

// Create payment intent for adding funds (clients only)
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

    // Get or create Stripe customer
    let customerId = user.stripeCustomerId;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: {
          userId: userId,
          userRole: user.role
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
      amount: amount,
      currency: 'usd',
      customer: customerId,
      automatic_payment_methods: {
        enabled: true,
      },
      metadata: {
        userId: userId,
        type: 'balance_deposit'
      },
      description: `Balance deposit for ${user.email}`
    });

    // Create pending transaction record
    const depositAmount = amount / 100; // Convert to dollars
    await prisma.transaction.create({
      data: {
        userId,
        type: 'DEPOSIT',
        amount: depositAmount,
        currency: 'USD',
        status: 'PENDING',
        description: `Balance deposit - $${depositAmount.toFixed(2)}`,
        stripePaymentIntentId: paymentIntent.id,
        metadata: {
          stripeCustomerId: customerId,
          depositType: 'stripe_payment'
        }
      }
    });

    res.json({
      success: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amount: depositAmount
    });

  } catch (error) {
    console.error('Create payment intent error:', error);
    res.status(500).json({ 
      message: 'Failed to create payment intent',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Confirm payment and add funds to balance
router.post('/confirm-payment', authMiddleware, requireClient, async (req, res) => {
  try {
    const { paymentIntentId } = req.body;
    const userId = req.user.userId;

    // Retrieve the payment intent from Stripe
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.metadata.userId !== userId) {
      return res.status(403).json({ message: 'Payment does not belong to this user' });
    }

    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ 
        message: 'Payment not completed',
        status: paymentIntent.status
      });
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

    if (transaction.status === 'SUCCEEDED') {
      return res.status(400).json({ message: 'Payment already processed' });
    }

    // Add funds to user balance and update transaction
    const addedAmount = paymentIntent.amount / 100; // Convert cents to dollars
    const stripeFee = Math.round((paymentIntent.amount * 0.029) + 30) / 100; // Approximate Stripe fee

    const result = await executeTransaction([
      prisma.user.update({
        where: { id: userId },
        data: { balance: { increment: addedAmount } }
      }),

      prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          status: 'SUCCEEDED',
          processedAt: new Date(),
          stripeFee: stripeFee,
          metadata: {
            ...transaction.metadata,
            stripePaymentIntentId: paymentIntentId,
            stripeFee: stripeFee
          }
        }
      })
    ]);

    res.json({
      success: true,
      message: 'Funds added successfully',
      addedAmount,
      newBalance: result[0].balance,
      transactionId: result[1].id
    });

  } catch (error) {
    console.error('Confirm payment error:', error);
    res.status(500).json({ 
      message: 'Failed to process payment',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Create Stripe Connect account for readers
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
      return res.status(400).json({ 
        message: 'Stripe account already exists',
        accountId: user.stripeAccountId
      });
    }

    // Create Stripe Connect account
    const account = await stripe.accounts.create({
      type: 'express',
      country: 'US',
      email: user.email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_type: 'individual',
      metadata: {
        userId: userId,
        userRole: 'READER'
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
      refresh_url: `${process.env.CLIENT_URL}/dashboard/reader?setup=refresh`,
      return_url: `${process.env.CLIENT_URL}/dashboard/reader?setup=complete`,
      type: 'account_onboarding',
    });

    res.json({
      success: true,
      accountId: account.id,
      onboardingUrl: accountLink.url
    });

  } catch (error) {
    console.error('Create connect account error:', error);
    res.status(500).json({ 
      message: 'Failed to create Stripe account',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get Stripe Connect account status
router.get('/connect-account-status', authMiddleware, requireReader, async (req, res) => {
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

    // Get account details from Stripe
    const account = await stripe.accounts.retrieve(user.stripeAccountId);

    const isComplete = account.details_submitted && 
                      account.charges_enabled && 
                      account.payouts_enabled;

    res.json({
      success: true,
      hasAccount: true,
      isComplete,
      accountId: user.stripeAccountId,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted
    });

  } catch (error) {
    console.error('Get connect account status error:', error);
    res.status(500).json({ 
      message: 'Failed to get account status',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Request manual payout (readers only)
router.post('/request-payout', authMiddleware, requireReader, async (req, res) => {
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
      return res.status(400).json({ message: 'No Stripe account found. Please complete account setup.' });
    }

    const pendingEarnings = user.pendingEarnings || 0;
    const minimumPayout = 15.00;

    if (pendingEarnings < minimumPayout) {
      return res.status(400).json({ 
        message: `Minimum payout amount is $${minimumPayout}`,
        currentEarnings: pendingEarnings,
        minimumRequired: minimumPayout
      });
    }

    // Create Stripe transfer
    const transfer = await stripe.transfers.create({
      amount: Math.round(pendingEarnings * 100), // Convert to cents
      currency: 'usd',
      destination: user.stripeAccountId,
      description: `Manual payout request for ${user.email}`,
      metadata: {
        userId: userId,
        payoutType: 'manual_request'
      }
    });

    // Update user earnings and create transaction record
    const result = await executeTransaction([
      prisma.user.update({
        where: { id: userId },
        data: {
          pendingEarnings: 0,
          paidEarnings: { increment: pendingEarnings },
          lastPayout: new Date()
        }
      }),

      prisma.transaction.create({
        data: {
          userId,
          type: 'PAYOUT',
          amount: pendingEarnings,
          currency: 'USD',
          status: 'SUCCEEDED',
          description: `Manual payout - $${pendingEarnings.toFixed(2)}`,
          stripeTransferId: transfer.id,
          processedAt: new Date(),
          metadata: {
            payoutType: 'manual_request',
            stripeTransferId: transfer.id
          }
        }
      })
    ]);

    res.json({
      success: true,
      message: 'Payout processed successfully',
      amount: pendingEarnings,
      transferId: transfer.id,
      newPendingEarnings: 0,
      newPaidEarnings: result[0].paidEarnings
    });

  } catch (error) {
    console.error('Request payout error:', error);
    res.status(500).json({ 
      message: 'Failed to process payout',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Stripe webhook handler
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
      type: 'card',
    });

    res.json({
      success: true,
      paymentMethods: paymentMethods.data.map(pm => ({
        id: pm.id,
        brand: pm.card.brand,
        last4: pm.card.last4,
        expMonth: pm.card.exp_month,
        expYear: pm.card.exp_year
      }))
    });

  } catch (error) {
    console.error('Get payment methods error:', error);
    res.status(500).json({ 
      message: 'Failed to retrieve payment methods',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Webhook handlers
async function handlePaymentIntentSucceeded(paymentIntent) {
  try {
    const transaction = await prisma.transaction.findFirst({
      where: { stripePaymentIntentId: paymentIntent.id }
    });

    if (transaction && transaction.status === 'PENDING') {
      const addedAmount = paymentIntent.amount / 100;
      const stripeFee = Math.round((paymentIntent.amount * 0.029) + 30) / 100;

      await executeTransaction([
        prisma.user.update({
          where: { id: transaction.userId },
          data: { balance: { increment: addedAmount } }
        }),

        prisma.transaction.update({
          where: { id: transaction.id },
          data: {
            status: 'SUCCEEDED',
            processedAt: new Date(),
            stripeFee: stripeFee
          }
        })
      ]);

      console.log(`Payment succeeded: $${addedAmount} added to user ${transaction.userId}`);
    }
  } catch (error) {
    console.error('Handle payment intent succeeded error:', error);
  }
}

async function handlePaymentIntentFailed(paymentIntent) {
  try {
    const transaction = await prisma.transaction.findFirst({
      where: { stripePaymentIntentId: paymentIntent.id }
    });

    if (transaction) {
      await prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          status: 'FAILED',
          failureReason: paymentIntent.last_payment_error?.message || 'Payment failed'
        }
      });

      console.log(`Payment failed for transaction ${transaction.id}`);
    }
  } catch (error) {
    console.error('Handle payment intent failed error:', error);
  }
}

async function handleTransferFailed(transfer) {
  try {
    const transaction = await prisma.transaction.findFirst({
      where: { stripeTransferId: transfer.id }
    });

    if (transaction) {
      // Restore pending earnings
      const user = await prisma.user.findUnique({ where: { id: transaction.userId } });
      
      await executeTransaction([
        prisma.user.update({
          where: { id: transaction.userId },
          data: {
            pendingEarnings: { increment: transaction.amount },
            paidEarnings: { decrement: transaction.amount }
          }
        }),

        prisma.transaction.update({
          where: { id: transaction.id },
          data: {
            status: 'FAILED',
            failureReason: transfer.failure_message || 'Transfer failed'
          }
        })
      ]);

      console.log(`Transfer failed, restored $${transaction.amount} to user ${transaction.userId}`);
    }
  } catch (error) {
    console.error('Handle transfer failed error:', error);
  }
}

async function handleAccountUpdated(account) {
  try {
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
  } catch (error) {
    console.error('Handle account updated error:', error);
  }
}

module.exports = router;