const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/wallet.controller');
const { authenticate, authorize } = require('../../middleware/auth');

router.post('/topup', authenticate, ctrl.topup);
router.get('/transactions', authenticate, ctrl.transactions);
router.get('/transactions/:userId', authenticate, ctrl.transactions);
router.post('/withdraw', authenticate, authorize('driver'), ctrl.withdraw);
router.post('/webhook', ctrl.webhook); // webhook doesn't require auth

module.exports = router;
