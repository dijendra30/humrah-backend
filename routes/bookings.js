// routes/bookings.js - Booking Routes
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Booking = require('../models/Booking');
const User = require('../models/User');

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
      status: 'pending'
    });

    await booking.save();
    await booking.populate('userId companionId', 'firstName lastName profilePhoto');

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