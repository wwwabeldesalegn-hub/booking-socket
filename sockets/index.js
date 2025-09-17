// sockets/index.js
let ioRef;
const jwt = require('jsonwebtoken');
const geolib = require('geolib');
const mongoose = require('mongoose');
require('dotenv').config();

// Models
const { Booking } = require('../models/bookingModels');
const { Driver, Passenger } = require('../models/userModels');

// In-memory storage for booking notes (last N notes per booking)
const bookingNotes = new Map();
const MAX_NOTES_PER_BOOKING = 50;

// Helper: join user to booking tunnel rooms for their active bookings
async function joinBookingRooms(socket, user) {
  if (!user || !user.id) return;
  
  try {
    const userType = String(user.type).toLowerCase();
    let query = {};
    
    if (userType === 'driver') {
      query = { driverId: String(user.id), status: { $in: ['accepted', 'ongoing'] } };
    } else if (userType === 'passenger') {
      query = { passengerId: String(user.id), status: { $in: ['requested', 'accepted', 'ongoing'] } };
    }
    
    const activeBookings = await Booking.find(query).select('_id').lean();
    activeBookings.forEach(booking => {
      const room = `booking:${String(booking._id)}`;
      socket.join(room);
      console.log(`${userType} ${user.id} joined booking room ${room}`);
    });
  } catch (err) {
    console.error('Error joining booking rooms:', err);
  }
}

// Helper: get stored notes for a booking
function getStoredNotes(bookingId) {
  return bookingNotes.get(String(bookingId)) || [];
}

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
            // Join booking tunnel rooms for active bookings
            await joinBookingRooms(socket, user);
          }
        } else if (normalizedType === 'passenger') {
          const passengerId = await resolvePassengerIdFromToken(decoded);
          user = { type: 'passenger', id: passengerId || (decoded.id ? String(decoded.id) : undefined), name: decoded.name, phone: decoded.phone || decoded.phoneNumber || decoded.mobile };
          socket.user = user;
          if (user.id) {
            socket.join(`passenger:${user.id}`);
            // Join booking tunnel rooms for active bookings
            await joinBookingRooms(socket, user);
          }
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
        const bookingId = String(booking._id);

        // Join passenger to booking tunnel room
        const bookingRoom = `booking:${bookingId}`;
        socket.join(bookingRoom);
        console.log(`Passenger ${passengerId} joined booking room ${bookingRoom}`);

        // Find active drivers nearby
        const drivers = await findActiveDrivers();
        const radiusKm = parseInt(process.env.RADIUS_KM || '5', 10);

        const nearbyDrivers = drivers.filter(d => d.lastKnownLocation && (
          geolib.getDistance(
            { latitude: d.lastKnownLocation.latitude, longitude: d.lastKnownLocation.longitude },
            { latitude: booking.pickup.latitude, longitude: booking.pickup.longitude }
          ) / 1000
        ) <= radiusKm);

        // Create patch for booking creation
        const patch = {
          bookingId,
          patch: {
            status: 'requested',
            passengerId,
            vehicleType: booking.vehicleType,
            pickup: booking.pickup,
            dropoff: booking.dropoff,
            passenger: {
              id: passengerId,
              name: socket.user && socket.user.name ? socket.user.name : undefined,
              phone: socket.user && socket.user.phone ? socket.user.phone : undefined
            }
          }
        };

        // Emit patch to nearby drivers via booking tunnel
        nearbyDrivers.forEach(d => {
          const driverRoomId = String(d._id || d.id);
          io.to(`driver:${driverRoomId}`).emit('booking:new', patch);
        });
        // Broadcast to all drivers as a fallback
        io.to('drivers').emit('booking:new', patch);

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
          return socket.emit('booking_error', { message: 'Unauthorized: driver token required', bookingId: bookingIdRaw });
        }

        if (!bookingIdRaw) {
          return socket.emit('booking_error', { message: 'bookingId is required', bookingId: bookingIdRaw });
        }

        let bookingObjectId;
        try {
          bookingObjectId = new mongoose.Types.ObjectId(String(bookingIdRaw));
        } catch (_) {
          return socket.emit('booking_error', { message: 'Invalid bookingId', bookingId: bookingIdRaw });
        }

        // Atomically accept only if still requested
        const now = new Date();
        const accepted = await Booking.findOneAndUpdate(
          { _id: bookingObjectId, status: 'requested' },
          { $set: { status: 'accepted', driverId: String(authUser.id), acceptedAt: now } },
          { new: true }
        ).lean();

        if (!accepted) {
          return socket.emit('booking_error', { message: 'Booking already accepted by another driver or not found', bookingId: bookingIdRaw });
        }

        const bookingId = String(accepted._id);
        const bookingRoom = `booking:${bookingId}`;

        // Join driver to booking tunnel room
        socket.join(bookingRoom);
        console.log(`Driver ${authUser.id} joined booking room ${bookingRoom}`);

        // Create patch for booking acceptance
        const patch = {
          bookingId,
          patch: {
            status: 'accepted',
            driverId: String(authUser.id),
            acceptedAt: now.toISOString(),
            driver: {
              id: String(authUser.id),
              name: authUser.name,
              phone: authUser.phone,
              vehicleType: authUser.vehicleType,
            }
          }
        };

        // Emit patch to booking tunnel room
        io.to(bookingRoom).emit('booking:update', patch);

        // Send confirmation to driver
        io.to(`driver:${String(authUser.id)}`).emit('booking:accepted', patch);

      } catch (err) {
        console.error('Error handling booking_accept:', err);
        // Attempt to include bookingId if present in the incoming payload
        try {
          const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
          return socket.emit('booking_error', { message: 'Failed to accept booking', bookingId: data && data.bookingId });
        } catch (_) {
          return socket.emit('booking_error', { message: 'Failed to accept booking' });
        }
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
          return socket.emit('booking_error', { message: 'Unauthorized: user token required', bookingId: bookingIdRaw });
        }

        if (!bookingIdRaw) {
          return socket.emit('booking_error', { message: 'bookingId is required', bookingId: bookingIdRaw });
        }

        let bookingObjectId;
        try {
          bookingObjectId = new mongoose.Types.ObjectId(String(bookingIdRaw));
        } catch (_) {
          return socket.emit('booking_error', { message: 'Invalid bookingId', bookingId: bookingIdRaw });
        }

        const canceledBy = String(authUser.type).toLowerCase() === 'driver' ? 'driver' : 'passenger';

        const updated = await Booking.findOneAndUpdate(
          { _id: bookingObjectId },
          { $set: { status: 'canceled', canceledBy, canceledReason: reason } },
          { new: true }
        ).lean();

        if (!updated) {
          return socket.emit('booking_error', { message: 'Booking not found', bookingId: bookingIdRaw });
        }

        const bookingId = String(updated._id);
        const bookingRoom = `booking:${bookingId}`;

        // Create patch for booking cancellation
        const patch = {
          bookingId,
          patch: {
            status: 'canceled',
            canceledBy,
            canceledReason: reason
          }
        };

        // Emit patch to booking tunnel room
        io.to(bookingRoom).emit('booking:update', patch);

        // Send confirmation to actor
        const actorRoom = canceledBy === 'driver' ? `driver:${String(authUser.id)}` : `passenger:${String(authUser.id)}`;
        io.to(actorRoom).emit('booking:cancelled', patch);

      } catch (err) {
        console.error('Error handling booking_cancel:', err);
        // Attempt to include bookingId if present in the incoming payload
        try {
          const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
          return socket.emit('booking_error', { message: 'Failed to cancel booking', bookingId: data && data.bookingId });
        } catch (_) {
          return socket.emit('booking_error', { message: 'Failed to cancel booking' });
        }
      }
    });

    // --- Handle booking notes from drivers or passengers ---
    socket.on('booking_note', async (payload) => {
      try {
        const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
        const bookingIdRaw = data.bookingId;
        const message = data.message;
        const authUser = socket.user;

        if (!authUser || !authUser.type) {
          return socket.emit('booking_error', { message: 'Unauthorized: user token required', bookingId: bookingIdRaw });
        }

        if (!bookingIdRaw) {
          return socket.emit('booking_error', { message: 'bookingId is required', bookingId: bookingIdRaw });
        }

        if (!message || typeof message !== 'string' || message.trim().length === 0) {
          return socket.emit('booking_error', { message: 'Message is required and must be non-empty', bookingId: bookingIdRaw });
        }

        let bookingObjectId;
        try {
          bookingObjectId = new mongoose.Types.ObjectId(String(bookingIdRaw));
        } catch (_) {
          return socket.emit('booking_error', { message: 'Invalid bookingId', bookingId: bookingIdRaw });
        }

        // Find the booking to verify authorization
        const booking = await Booking.findById(bookingObjectId).lean();
        if (!booking) {
          return socket.emit('booking_error', { message: 'Booking not found', bookingId: bookingIdRaw });
        }

        // Verify the sender is either the driver or passenger of this booking
        const userType = String(authUser.type).toLowerCase();
        const isAuthorized = 
          (userType === 'driver' && booking.driverId && String(booking.driverId) === String(authUser.id)) ||
          (userType === 'passenger' && booking.passengerId && String(booking.passengerId) === String(authUser.id));

        if (!isAuthorized) {
          return socket.emit('booking_error', { message: 'Unauthorized: you are not the driver or passenger of this booking', bookingId: bookingIdRaw });
        }

        // Create note object
        const note = {
          bookingId: String(bookingIdRaw),
          sender: userType,
          message: message.trim(),
          timestamp: new Date().toISOString()
        };

        // Store note in memory (last N notes per booking)
        const bookingIdStr = String(bookingIdRaw);
        if (!bookingNotes.has(bookingIdStr)) {
          bookingNotes.set(bookingIdStr, []);
        }
        const notes = bookingNotes.get(bookingIdStr);
        notes.push(note);
        
        // Keep only the last N notes
        if (notes.length > MAX_NOTES_PER_BOOKING) {
          notes.splice(0, notes.length - MAX_NOTES_PER_BOOKING);
        }

        // Emit to booking tunnel room
        io.to(`booking:${bookingIdStr}`).emit('booking:note', note);

      } catch (err) {
        console.error('Error handling booking_note:', err);
        // Attempt to include bookingId if present in the incoming payload
        try {
          const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
          return socket.emit('booking_error', { message: 'Failed to send note', bookingId: data && data.bookingId });
        } catch (_) {
          return socket.emit('booking_error', { message: 'Failed to send note' });
        }
      }
    });

    // --- Fetch stored notes for a booking (for late-joining sockets) ---
    socket.on('booking_notes_fetch', async (payload) => {
      try {
        const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
        const bookingIdRaw = data.bookingId;
        const authUser = socket.user;

        if (!authUser || !authUser.type) {
          return socket.emit('booking_error', { message: 'Unauthorized: user token required', bookingId: bookingIdRaw });
        }

        if (!bookingIdRaw) {
          return socket.emit('booking_error', { message: 'bookingId is required', bookingId: bookingIdRaw });
        }

        let bookingObjectId;
        try {
          bookingObjectId = new mongoose.Types.ObjectId(String(bookingIdRaw));
        } catch (_) {
          return socket.emit('booking_error', { message: 'Invalid bookingId', bookingId: bookingIdRaw });
        }

        // Find the booking to verify authorization
        const booking = await Booking.findById(bookingObjectId).lean();
        if (!booking) {
          return socket.emit('booking_error', { message: 'Booking not found', bookingId: bookingIdRaw });
        }

        // Verify the user is either the driver or passenger of this booking
        const userType = String(authUser.type).toLowerCase();
        const isAuthorized = 
          (userType === 'driver' && booking.driverId && String(booking.driverId) === String(authUser.id)) ||
          (userType === 'passenger' && booking.passengerId && String(booking.passengerId) === String(authUser.id));

        if (!isAuthorized) {
          return socket.emit('booking_error', { message: 'Unauthorized: you are not the driver or passenger of this booking', bookingId: bookingIdRaw });
        }

        // Get stored notes
        const notes = getStoredNotes(bookingIdRaw);
        socket.emit('booking:notes_history', { bookingId: String(bookingIdRaw), notes });

      } catch (err) {
        console.error('Error handling booking_notes_fetch:', err);
        // Attempt to include bookingId if present in the incoming payload
        try {
          const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
          return socket.emit('booking_error', { message: 'Failed to fetch notes', bookingId: data && data.bookingId });
        } catch (_) {
          return socket.emit('booking_error', { message: 'Failed to fetch notes' });
        }
      }
    });

    // Handle disconnect - leave booking rooms
    socket.on('disconnect', () => {
      console.log(`Socket disconnected: ${socket.id}`);
      
      // Note: Socket.IO automatically removes sockets from all rooms on disconnect
      // This is just for logging purposes
      if (socket.user && socket.user.id) {
        console.log(`${socket.user.type} ${socket.user.id} disconnected and left all rooms`);
      }
    });
  });
}

module.exports = { attachSocketHandlers };
