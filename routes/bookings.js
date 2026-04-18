// routes/bookings.js - Booking Routes
const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const Booking = require('../models/Booking');
const User = require('../models/User');

// ─── helper: push a lightweight booking ref into a user doc ───────────────────
async function pushBookingRef(userId, { bookingId, otherUserId, otherUserEmail, status }) {
  return User.findByIdAndUpdate(
    userId,
    {
      $push: {
        bookingRefs: {
          bookingId,
          otherUserId,
          otherUserEmail: otherUserEmail || null,
          status,
          type: 'FREE',
          createdAt: new Date()
        }
      }
    },
    { new: false }   // we don't need the doc back — fire-and-forget style
  ).catch(err => console.error('[BookingRef] pushBookingRef error:', err.message));
}

// ─── helper: sync status in both users' bookingRefs ──────────────────────────
async function syncBookingRefStatus(bookingId, newStatus) {
  return User.updateMany(
    { 'bookingRefs.bookingId': bookingId },
    { $set: { 'bookingRefs.$[el].status': newStatus } },
    { arrayFilters: [{ 'el.bookingId': bookingId }] }
  ).catch(err => console.error('[BookingRef] syncBookingRefStatus error:', err.message));
}


// @route   POST /api/bookings
// @desc    Create a new booking
// @access  Private
router.post('/', auth, async (req, res) => {
  try {
    const { companionId, bookingDate, meetingLocation, notes } = req.body;

    const companion = await User.findById(companionId);
    if (!companion) {
      return res.status(404).json({ 
        success: false, 
        message: 'Companion not found' 
      });
    }

    const booking = new Booking({
      userId: req.userId,
      companionId,
      bookingDate: new Date(bookingDate),
      meetingLocation,
      notes,
      status: 'pending',
      totalAmount: 0   // FREE for now
    });

    await booking.save();
    await booking.populate('userId companionId', 'firstName lastName profilePhoto email');

    // —— Push lightweight booking refs into BOTH users ——
    // Intentionally NOT awaited so the HTTP response is not delayed.
    // Both ops use $push which is atomic per-document.
    const initiatorEmail  = booking.userId?.email  || null;
    const receiverEmail   = booking.companionId?.email || null;

    pushBookingRef(req.userId, {
      bookingId:      booking._id,
      otherUserId:    companionId,
      otherUserEmail: receiverEmail,
      status:         'pending'
    });

    pushBookingRef(companionId, {
      bookingId:      booking._id,
      otherUserId:    req.userId,
      otherUserEmail: initiatorEmail,
      status:         'pending'
    });

    res.status(201).json({
      success: true,
      message: 'Booking created successfully',
      booking
    });

  } catch (error) {
    console.error('Create booking error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});

// @route   GET /api/bookings/my
// @desc    Get current user's bookings
// @access  Private
router.get('/my', auth, async (req, res) => {
  try {
    const bookings = await Booking.find({
      $or: [{ userId: req.userId }, { companionId: req.userId }]
    })
    .populate('userId companionId', 'firstName lastName profilePhoto')
    .sort({ bookingDate: -1 });

    res.json({
      success: true,
      bookings
    });

  } catch (error) {
    console.error('Get bookings error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});

// @route   PUT /api/bookings/:id/status
// @desc    Update booking status
// @access  Private
router.put('/:id/status', auth, async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['pending', 'confirmed', 'cancelled', 'completed'];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid status' 
      });
    }

    const booking = await Booking.findById(req.params.id);
    
    if (!booking) {
      return res.status(404).json({ 
        success: false, 
        message: 'Booking not found' 
      });
    }

    if (booking.userId.toString() !== req.userId && 
        booking.companionId.toString() !== req.userId) {
      return res.status(403).json({ 
        success: false, 
        message: 'Not authorized' 
      });
    }

    booking.status = status;
    await booking.save();
    await booking.populate('userId companionId', 'firstName lastName profilePhoto');

    // Keep bookingRefs in sync — non-blocking
    syncBookingRefStatus(booking._id, status);

    res.json({
      success: true,
      message: 'Booking status updated',
      booking
    });

  } catch (error) {
    console.error('Update booking error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});


module.exports = router;
