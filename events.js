// routes/events.js - Event Routes
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Event = require('../models/Event');

// @route   GET /api/events
// @desc    Get all active events
// @access  Private
router.get('/', auth, async (req, res) => {
  try {
    const { category } = req.query;
    const filter = { isActive: true };
    
    if (category) {
      filter.category = category;
    }

    const events = await Event.find(filter)
      .populate('createdBy', 'firstName lastName')
      .sort({ createdAt: -1 })
      .limit(50);

    res.json({
      success: true,
      events
    });

  } catch (error) {
    console.error('Get events error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});

// @route   POST /api/events/:id/join
// @desc    Join an event
// @access  Private
router.post('/:id/join', auth, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);

    if (!event) {
      return res.status(404).json({ 
        success: false, 
        message: 'Event not found' 
      });
    }

    if (event.participants.includes(req.userId)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Already joined this event' 
      });
    }

    if (event.participants.length >= event.maxParticipants) {
      return res.status(400).json({ 
        success: false, 
        message: 'Event is full' 
      });
    }

    event.participants.push(req.userId);
    await event.save();

    res.json({
      success: true,
      message: 'Successfully joined event',
      event
    });

  } catch (error) {
    console.error('Join event error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});

// @route   POST /api/events/:id/leave
// @desc    Leave an event
// @access  Private
router.post('/:id/leave', auth, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);

    if (!event) {
      return res.status(404).json({ 
        success: false, 
        message: 'Event not found' 
      });
    }

    event.participants = event.participants.filter(
      p => p.toString() !== req.userId
    );
    await event.save();

    res.json({
      success: true,
      message: 'Successfully left event',
      event
    });

  } catch (error) {
    console.error('Leave event error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});

module.exports = router;