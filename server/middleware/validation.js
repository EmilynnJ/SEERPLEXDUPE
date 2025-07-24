const { body, validationResult } = require('express-validator');

// Handle validation errors
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      message: 'Validation failed',
      errors: errors.array()
    });
  }
  next();
};

// User registration validation
const validateUserRegistration = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email address'),
  
  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters long')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Password must contain at least one uppercase letter, one lowercase letter, and one number'),
  
  body('name')
    .optional()
    .isLength({ min: 2, max: 50 })
    .withMessage('Name must be between 2 and 50 characters')
    .trim(),
  
  handleValidationErrors
];

// User login validation
const validateUserLogin = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email address'),
  
  body('password')
    .notEmpty()
    .withMessage('Password is required'),
  
  handleValidationErrors
];

// Profile update validation
const validateProfileUpdate = [
  body('name')
    .optional()
    .isLength({ min: 2, max: 50 })
    .withMessage('Name must be between 2 and 50 characters')
    .trim(),
  
  body('bio')
    .optional()
    .isLength({ max: 1000 })
    .withMessage('Bio must be less than 1000 characters')
    .trim(),
  
  body('specialties')
    .optional()
    .isArray()
    .withMessage('Specialties must be an array'),
  
  body('specialties.*')
    .optional()
    .isLength({ min: 2, max: 50 })
    .withMessage('Each specialty must be between 2 and 50 characters')
    .trim(),
  
  body('avatar')
    .optional()
    .isURL()
    .withMessage('Avatar must be a valid URL'),
  
  handleValidationErrors
];

// Reader rates validation
const validateReaderRates = [
  body('rates.video')
    .optional()
    .isFloat({ min: 0.50, max: 50.00 })
    .withMessage('Video rate must be between $0.50 and $50.00'),
  
  body('rates.audio')
    .optional()
    .isFloat({ min: 0.50, max: 50.00 })
    .withMessage('Audio rate must be between $0.50 and $50.00'),
  
  body('rates.chat')
    .optional()
    .isFloat({ min: 0.50, max: 50.00 })
    .withMessage('Chat rate must be between $0.50 and $50.00'),
  
  handleValidationErrors
];

// Session request validation
const validateSessionRequest = [
  body('readerId')
    .notEmpty()
    .withMessage('Reader ID is required')
    .isLength({ min: 20, max: 30 })
    .withMessage('Invalid reader ID format'),
  
  body('sessionType')
    .isIn(['VIDEO', 'AUDIO', 'CHAT'])
    .withMessage('Session type must be VIDEO, AUDIO, or CHAT'),
  
  handleValidationErrors
];

// Payment amount validation
const validatePaymentAmount = [
  body('amount')
    .isInt({ min: 500, max: 50000 }) // $5.00 to $500.00 in cents
    .withMessage('Amount must be between $5.00 and $500.00'),
  
  handleValidationErrors
];

// Message validation
const validateMessage = [
  body('content')
    .notEmpty()
    .withMessage('Message content is required')
    .isLength({ min: 1, max: 2000 })
    .withMessage('Message must be between 1 and 2000 characters')
    .trim(),
  
  body('receiverId')
    .notEmpty()
    .withMessage('Receiver ID is required'),
  
  body('messageType')
    .optional()
    .isIn(['TEXT', 'IMAGE', 'FILE', 'SYSTEM'])
    .withMessage('Invalid message type'),
  
  handleValidationErrors
];

// Booking validation
const validateBooking = [
  body('readerId')
    .notEmpty()
    .withMessage('Reader ID is required'),
  
  body('scheduledTime')
    .isISO8601()
    .withMessage('Scheduled time must be a valid date')
    .custom((value) => {
      const scheduledDate = new Date(value);
      const now = new Date();
      if (scheduledDate <= now) {
        throw new Error('Scheduled time must be in the future');
      }
      return true;
    }),
  
  body('duration')
    .isInt({ min: 15, max: 180 })
    .withMessage('Duration must be between 15 and 180 minutes'),
  
  body('sessionType')
    .isIn(['VIDEO', 'AUDIO', 'CHAT'])
    .withMessage('Session type must be VIDEO, AUDIO, or CHAT'),
  
  body('timezone')
    .notEmpty()
    .withMessage('Timezone is required'),
  
  handleValidationErrors
];

// Review validation
const validateReview = [
  body('rating')
    .isInt({ min: 1, max: 5 })
    .withMessage('Rating must be between 1 and 5'),
  
  body('review')
    .optional()
    .isLength({ max: 1000 })
    .withMessage('Review must be less than 1000 characters')
    .trim(),
  
  handleValidationErrors
];

module.exports = {
  validateUserRegistration,
  validateUserLogin,
  validateProfileUpdate,
  validateReaderRates,
  validateSessionRequest,
  validatePaymentAmount,
  validateMessage,
  validateBooking,
  validateReview,
  handleValidationErrors
};