const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config();

const BASE_URL = process.env.SANTIMPAY_BASE_URL || 'https://gateway.santimpay.com/api';
const GATEWAY_MERCHANT_ID = process.env.GATEWAY_MERCHANT_ID ;

function importPrivateKey(pem) {
  return crypto.createPrivateKey({ key: pem, format: 'pem' });
}

function signES256(payload, privateKeyPem) {
  const header = { alg: 'ES256', typ: 'JWT' };
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${encode(header)}.${encode(payload)}`;
  const sign = crypto.createSign('SHA256');
  sign.update(unsigned);
  sign.end();
  const key = importPrivateKey(privateKeyPem);
  const signature = sign.sign({ key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${unsigned}.${signature}`;
}

async function generateSignedTokenForDirectPayment(amount, paymentReason, paymentMethod, phoneNumber) {
  const time = Math.floor(Date.now() / 1000);
  const payload = {
    amount,
    paymentReason,
    paymentMethod,
    phoneNumber,
    merchantId: GATEWAY_MERCHANT_ID,
    generated: time
  };
  const token = signES256(payload, process.env.PRIVATE_KEY_IN_PEM);
  return token;
}

async function DirectPayment(id, amount, paymentReason, notifyUrl, phoneNumber, paymentMethod) {
  // Gateway expects specific payment method casing
  const method = paymentMethod;
  const token = await generateSignedTokenForDirectPayment(amount, paymentReason, method, phoneNumber);
  const payload = {
    ID: id,
    Amount: amount,
    Reason: paymentReason,
    MerchantID: GATEWAY_MERCHANT_ID,
    SignedToken: token,
    PhoneNumber: phoneNumber,
    NotifyURL: notifyUrl,
    PaymentMethod: method
  };
  const url = `${BASE_URL}/direct-payment`;
  try {
    const res = await axios.post(url, payload, { headers: { 'Content-Type': 'application/json' } });
    return res.data;
  } catch (e) {
    const status = e.response?.status || 'ERR';
    const data = e.response?.data;
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    throw new Error(`SantimPay direct-payment failed: ${status} ${text}`);
  }
}

module.exports = { generateSignedTokenForDirectPayment, DirectPayment };

