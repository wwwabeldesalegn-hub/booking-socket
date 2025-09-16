const express = require('express');
const router = express.Router();

// Public webhook echo endpoint
router.post('/public', (req, res) => {
  return res.json({
    ok: true,
    receivedAt: new Date().toISOString(),
    method: req.method,
    path: req.path,
    headers: req.headers,
    query: req.query,
    body: req.body
  });
});

// Optional GET for simple verification
router.get('/public', (req, res) => {
  return res.json({
    ok: true,
    receivedAt: new Date().toISOString(),
    method: req.method,
    path: req.path,
    headers: req.headers,
    query: req.query
  });
});

module.exports = router;

