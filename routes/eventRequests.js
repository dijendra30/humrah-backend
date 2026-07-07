const express = require('express');
const router = express.Router();
const EventRequest = require('../models/EventRequest');
const { auth, adminOnly } = require('../middleware/auth');

// ─────────────────────────────────────────────────────────────────────────────
// USER ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// @route   POST /api/event-requests
// @desc    Submit a new event request idea
// @access  Private
router.post('/', async (req, res) => {
  try {
    const {
      title,
      category,
      description,
      preferredDate,
      preferredTime,
      city,
      venueSuggestion,
      organizerName,
      phoneNumber,
      extraMessage
    } = req.body;

    const userId = req.user.id;

    // 1. Validate required fields
    if (!title || !category || !description || !city || !phoneNumber || !organizerName) {
      return res.status(400).json({ success: false, message: 'Please provide all required fields' });
    }

    // 2. Spam Protection: Max 5 pending requests per user
    const pendingCount = await EventRequest.countDocuments({ userId, status: 'PENDING' });
    if (pendingCount >= 5) {
      return res.status(429).json({ 
        success: false, 
        message: 'You already have multiple event requests under review.' 
      });
    }

    // 3. Create EventRequest
    const newRequest = new EventRequest({
      userId,
      title,
      category,
      description,
      preferredDate,
      preferredTime,
      city,
      venueSuggestion,
      organizerName,
      phoneNumber,
      extraMessage
    });

    await newRequest.save();

    console.log(`[Event Request] New request: user=${userId} city=${city} category=${category}`);

    return res.status(201).json({
      success: true,
      message: "Your event idea has been submitted successfully. Our team will review it and contact you if selected."
    });

  } catch (error) {
    console.error('Error creating event request:', error);
    return res.status(500).json({ success: false, message: 'Server Error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// @route   GET /api/event-requests/admin/all
// @desc    Get all event requests (Admin only)
// @access  Private / Admin
router.get('/admin/all', adminOnly, async (req, res) => {
  try {
    const requests = await EventRequest.find()
      .populate('userId', 'name email phone')
      .sort({ createdAt: -1 });
    
    return res.status(200).json({ success: true, requests });
  } catch (error) {
    console.error('Error fetching event requests:', error);
    return res.status(500).json({ success: false, message: 'Server Error' });
  }
});

// @route   PATCH /api/event-requests/admin/:id/status
// @desc    Update status of an event request
// @access  Private / Admin
router.patch('/admin/:id/status', adminOnly, async (req, res) => {
  try {
    const { status, adminNotes } = req.body;
    
    const allowedStatuses = ['PENDING', 'CONTACTED', 'APPROVED', 'REJECTED'];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    const request = await EventRequest.findById(req.params.id);
    if (!request) {
      return res.status(404).json({ success: false, message: 'Event request not found' });
    }

    request.status = status;
    if (adminNotes !== undefined) request.adminNotes = adminNotes;
    request.reviewedAt = Date.now();

    await request.save();

    console.log(`[Event Request Review] id=${req.params.id} status=${status}`);

    return res.status(200).json({ success: true, request });
  } catch (error) {
    console.error('Error updating event request status:', error);
    return res.status(500).json({ success: false, message: 'Server Error' });
  }
});

module.exports = router;
