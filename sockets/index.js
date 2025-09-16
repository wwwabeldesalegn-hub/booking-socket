// sockets/index.js
let ioRef;
const jwt = require('jsonwebtoken');
const geolib = require('geolib');
const mongoose = require('mongoose');
require('dotenv').config();

// Models
const { Booking } = require('../models/bookingModels');
const { Driver, Passenger } = require('../models/userModels');

// Helper: find all active drivers
async function findActiveDrivers() {
  return Driver.find({ available: true }).lean();
}

// Resolve a canonical driver document from token claims
async function resolveDriverFromToken(decoded) {
  if (!decoded) return null;
  const id = decoded.id ? String(decoded.id) : null;
  const phone = decoded.phone || decoded.phoneNumber || decoded.mobile;
  const email = decoded.email;
  const externalId = decoded.externalId || decoded.userExternalId;
  const candidates = [];
  if (id) candidates.push({ _id: id });
  if (externalId) candidates.push({ externalId: externalId });
  if (phone) candidates.push({ phone: phone });
  if (email) candidates.push({ email: email });
  for (const query of candidates) {
    const doc = await Driver.findOne(query).lean();
    if (doc) return doc;
  }
  return null;
}

// Resolve a canonical passenger id from token claims (best-effort)
async function resolvePassengerIdFromToken(decoded) {
  if (!decoded) return null;
  const id = decoded.id ? String(decoded.id) : null;
  const phone = decoded.phone || decoded.phoneNumber || decoded.mobile;
  const email = decoded.email;
  const externalId = decoded.externalId || decoded.userExternalId;
  // Try exact id first (ObjectId or string)
  if (id) {
    try { const p = await Passenger.findById(id).select({ _id: 1 }).lean(); if (p) return String(p._id); } catch (_) {}
  }
  // Then other identifiers
  const altQueries = [];
  if (externalId) altQueries.push({ externalId });
  if (phone) altQueries.push({ phone });
  if (email) altQueries.push({ email });
  for (const q of altQueries) {
    const p = await Passenger.findOne(q).select({ _id: 1 }).lean();
    if (p) return String(p._id);
  }
  // Fallback to token id string
  return id || null;
}

function attachSocketHandlers(io) {
  if (ioRef) {
    console.warn('Socket server already attached. Overwriting ioRef.');
  }
  ioRef = io;

  io.on('connection', async (socket) => {
    let user = null;

    // --- Authenticate user on connect ---
    try {
      const rawToken = socket.handshake.auth?.token
        || socket.handshake.query?.token
        || socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');
      if (rawToken) {
        const decoded = jwt.verify(rawToken, process.env.JWT_SECRET || 'secret');
        const normalizedType = decoded && decoded.type ? String(decoded.type).toLowerCase() : '';
        // Build canonical user context backed by DB ids
        if (normalizedType === 'driver') {
          const driverDoc = await resolveDriverFromToken(decoded);
          const driverId = driverDoc ? String(driverDoc._id) : (decoded.id ? String(decoded.id) : undefined);
          user = { type: 'driver', id: driverId, vehicleType: driverDoc?.vehicleType, name: driverDoc?.name || decoded.name, phone: driverDoc?.phone || (decoded.phone || decoded.phoneNumber || decoded.mobile) };
          socket.user = user;
          if (driverId) {
            const room = `driver:${driverId}`;
            socket.join(room);
            socket.join('drivers');
            console.log(`Driver ${driverId} joined room ${room} and 'drivers'`);
          }
        } else if (normalizedType === 'passenger') {
          const passengerId = await resolvePassengerIdFromToken(decoded);
          user = { type: 'passenger', id: passengerId || (decoded.id ? String(decoded.id) : undefined), name: decoded.name, phone: decoded.phone || decoded.phoneNumber || decoded.mobile };
          socket.user = user;
          if (user.id) socket.join(`passenger:${user.id}`);
        } else {
          throw new Error('Unsupported user type');
        }
      }
    } catch (err) {
      console.error('Socket auth error:', err);
      socket.disconnect(true);
      return;
    }

    // --- Handle incoming booking requests from passengers ---
    socket.on('booking_request', async (payload) => {
      try {
        // Ensure payload is an object
        const bookingData = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});

        // Require authenticated passenger
        const authUser = socket.user;
        if (!authUser || String(authUser.type).toLowerCase() !== 'passenger') {
          return socket.emit('booking_error', { message: 'Unauthorized: passenger token required' });
        }

        // Inject required fields (prefer canonical DB id if available)
        const passengerId = socket.user && socket.user.id ? String(socket.user.id) : String(authUser.id);
        bookingData.passengerId = passengerId;
        bookingData.vehicleType = bookingData.vehicleType || 'mini';
        bookingData.status = bookingData.status || 'requested';

        // Save booking
        const booking = await Booking.create(bookingData);

        // Find active drivers nearby
        const drivers = await findActiveDrivers();
        const radiusKm = parseInt(process.env.RADIUS_KM || '5', 10);

        const nearbyDrivers = drivers.filter(d => d.lastKnownLocation && (
          geolib.getDistance(
            { latitude: d.lastKnownLocation.latitude, longitude: d.lastKnownLocation.longitude },
            { latitude: booking.pickup.latitude, longitude: booking.pickup.longitude }
          ) / 1000
        ) <= radiusKm);

        const bookingJson = booking.toObject ? booking.toObject() : booking;
        const bookingPayload = {
          ...bookingJson,
          passenger: {
            id: passengerId,
            name: socket.user && socket.user.name ? socket.user.name : undefined,
            phone: socket.user && socket.user.phone ? socket.user.phone : undefined
          }
        };

        nearbyDrivers.forEach(d => {
          const driverRoomId = String(d._id || d.id);
          io.to(`driver:${driverRoomId}`).emit('booking:new', bookingPayload);
        });
        // Broadcast to all drivers as a fallback to avoid ID mismatches between JWT and DB
        io.to('drivers').emit('booking:new', bookingPayload);

      } catch (err) {
        console.error('Error handling booking_request:', err);
      }
    });

    // --- Driver accepts a booking ---
    socket.on('booking_accept', async (payload) => {
      try {
        const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
        const bookingIdRaw = data.bookingId;
        const authUser = socket.user;
        if (!authUser || String(authUser.type).toLowerCase() !== 'driver' || !authUser.id) {
          return socket.emit('booking_error', { message: 'Unauthorized: driver token required' });
        }

        if (!bookingIdRaw) {
          return socket.emit('booking_error', { message: 'bookingId is required' });
        }

        let bookingObjectId;
        try {
          bookingObjectId = new mongoose.Types.ObjectId(String(bookingIdRaw));
        } catch (_) {
          return socket.emit('booking_error', { message: 'Invalid bookingId' });
        }

        // Atomically accept only if still requested
        const now = new Date();
        const accepted = await Booking.findOneAndUpdate(
          { _id: bookingObjectId, status: 'requested' },
          { $set: { status: 'accepted', driverId: String(authUser.id), acceptedAt: now } },
          { new: true }
        ).lean();

        if (!accepted) {
          return socket.emit('booking_error', { message: 'Booking already accepted by another driver or not found' });
        }

        const driverInfo = {
          id: String(authUser.id),
          name: authUser.name,
          phone: authUser.phone,
          vehicleType: authUser.vehicleType,
        };

        const bookingPayload = { ...accepted, driver: driverInfo };

        if (accepted.passengerId) {
          io.to(`passenger:${String(accepted.passengerId)}`).emit('booking:update', bookingPayload);
        }

        io.to(`driver:${String(authUser.id)}`).emit('booking:accepted', bookingPayload);
      } catch (err) {
        console.error('Error handling booking_accept:', err);
        socket.emit('booking_error', { message: 'Failed to accept booking' });
      }
    });

    // --- Driver or passenger cancels a booking ---
    socket.on('booking_cancel', async (payload) => {
      try {
        const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
        const bookingIdRaw = data.bookingId;
        const reason = data.reason;
        const authUser = socket.user;
        if (!authUser || !authUser.type) {
          return socket.emit('booking_error', { message: 'Unauthorized: user token required' });
        }

        if (!bookingIdRaw) {
          return socket.emit('booking_error', { message: 'bookingId is required' });
        }

        let bookingObjectId;
        try {
          bookingObjectId = new mongoose.Types.ObjectId(String(bookingIdRaw));
        } catch (_) {
          return socket.emit('booking_error', { message: 'Invalid bookingId' });
        }

        const canceledBy = String(authUser.type).toLowerCase() === 'driver' ? 'driver' : 'passenger';

        const updated = await Booking.findOneAndUpdate(
          { _id: bookingObjectId },
          { $set: { status: 'canceled', canceledBy, canceledReason: reason } },
          { new: true }
        ).lean();

        if (!updated) {
          return socket.emit('booking_error', { message: 'Booking not found' });
        }

        const payloadOut = { ...updated, canceledBy };

        if (updated.passengerId) {
          io.to(`passenger:${String(updated.passengerId)}`).emit('booking:update', payloadOut);
        }
        if (updated.driverId) {
          io.to(`driver:${String(updated.driverId)}`).emit('booking:update', payloadOut);
        }

        // Confirmation to actor
        const actorRoom = canceledBy === 'driver' ? `driver:${String(authUser.id)}` : `passenger:${String(authUser.id)}`;
        io.to(actorRoom).emit('booking:cancelled', payloadOut);
      } catch (err) {
        console.error('Error handling booking_cancel:', err);
        socket.emit('booking_error', { message: 'Failed to cancel booking' });
      }
    });

    // Optional: disconnect log
    socket.on('disconnect', () => {
      console.log(`Socket disconnected: ${socket.id}`);
    });
  });
}

module.exports = { attachSocketHandlers };
