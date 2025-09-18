const { Wallet, Transaction } = require('../models/common');

exports.getWallet = async (req, res) => {
  try {
    const driverId = req.params.id;
    const wallet = await Wallet.findOne({ userId: String(driverId), role: 'driver' }).lean();
    return res.json(wallet || { userId: String(driverId), role: 'driver', balance: 0, totalEarnings: 0, currency: 'ETB' });
  } catch (e) { return res.status(500).json({ message: e.message }); }
};

exports.adjustBalance = async (req, res) => {
  try {
    const driverId = req.params.id;
    const { amount, reason = 'Admin Adjustment' } = req.body || {};
    if (!amount || amount === 0) return res.status(400).json({ message: 'amount must be non-zero' });

    const txType = amount > 0 ? 'credit' : 'debit';
    const absAmount = Math.abs(Number(amount));

    // Create transaction record for audit
    const tx = await Transaction.create({
      userId: String(driverId),
      role: 'driver',
      amount: absAmount,
      type: txType,
      method: 'cash',
      status: 'success',
      metadata: { reason }
    });

    // Update wallet balance
    const update = amount > 0 ? { $inc: { balance: absAmount } } : { $inc: { balance: -absAmount } };
    const wallet = await Wallet.findOneAndUpdate(
      { userId: String(driverId), role: 'driver' },
      update,
      { new: true, upsert: true }
    );

    return res.json({ wallet, transactionId: String(tx._id) });
  } catch (e) { return res.status(500).json({ message: e.message }); }
};

exports.listTransactions = async (req, res) => {
  try {
    const driverId = req.params.id;
    const rows = await Transaction.find({ userId: String(driverId), role: 'driver' }).sort({ createdAt: -1 }).lean();
    return res.json(rows);
  } catch (e) { return res.status(500).json({ message: e.message }); }
};

