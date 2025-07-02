const express = require('express');

const router = express.Router();

// Basic stripe routes
router.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

module.exports = router;