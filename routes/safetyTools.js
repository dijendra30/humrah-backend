// routes/safetyTools.js
// Auth is applied globally in server.js — DO NOT add auth per-route here.

const express = require('express');
const router  = express.Router();
const IncidentNote   = require('../models/IncidentNote');
const TrustedContact = require('../models/TrustedContact');
const SafetyReport   = require('../models/SafetyReport');

// ─────────────────────────────────────────────────────────────────────────────
// INCIDENT NOTES
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/safety-tools/incidents
// Body: { relatedUserId?, category, description, sharedWithHumrah }
router.post('/incidents', async (req, res) => {
    try {
        const { relatedUserId, category, description, sharedWithHumrah } = req.body;

        if (!sharedWithHumrah) {
            return res.json({
                success: true,
                message: 'Concern saved privately on your device.',
                stored: false
            });
        }

        const note = await IncidentNote.create({
            userId:           req.userId,
            relatedUserId:    relatedUserId || null,
            category:         category || '',
            description:      (description || '').trim().substring(0, 500),
            sharedWithHumrah: true
        });

        res.json({
            success: true,
            message: 'Concern saved and shared with the Humrah safety team.',
            noteId:  note._id,
            stored:  true
        });
    } catch (err) {
        console.error('Save incident error:', err);
        res.status(500).json({ success: false, message: 'Could not save concern.' });
    }
});

// GET /api/safety-tools/incidents
router.get('/incidents', async (req, res) => {
    try {
        const notes = await IncidentNote.find({ userId: req.userId })
            .sort({ createdAt: -1 })
            .limit(50)
            .populate('relatedUserId', 'firstName lastName profilePhoto');

        res.json({ success: true, incidents: notes });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Could not fetch incidents.' });
    }
});

// POST /api/safety-tools/incidents/:id/escalate
router.post('/incidents/:id/escalate', async (req, res) => {
    try {
        const note = await IncidentNote.findOne({ _id: req.params.id, userId: req.userId });
        if (!note) return res.status(404).json({ success: false, message: 'Incident not found.' });

        const categoryMap = {
            'felt_uncomfortable':       'HARASSMENT',
            'inappropriate_message':    'INAPPROPRIATE_CONTENT',
            'felt_pressured_or_unsafe': 'UNSAFE_MEETUP',
            'something_else':           'OTHER',
            '':                         'OTHER'
        };

        const report = await SafetyReport.create({
            reporterId:      req.userId,
            reportedUserId:  note.relatedUserId || null,
            category:        categoryMap[note.category] || 'OTHER',
            description:     note.description,
            isGeneralReport: !note.relatedUserId
        });

        note.escalatedToReportId = report._id;
        note.sharedWithHumrah    = true;
        await note.save();

        res.json({
            success:  true,
            message:  'Your concern has been escalated to a formal report.',
            reportId: report._id
        });
    } catch (err) {
        console.error('Escalate incident error:', err);
        res.status(500).json({ success: false, message: 'Could not escalate concern.' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// TRUSTED CONTACT
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/safety-tools/trusted-contact
router.get('/trusted-contact', async (req, res) => {
    try {
        const contact = await TrustedContact.findOne({ userId: req.userId });
        res.json({ success: true, contact: contact || null });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Could not load trusted contact.' });
    }
});

// POST /api/safety-tools/trusted-contact
// Body: { name, phone, relationship? }
router.post('/trusted-contact', async (req, res) => {
    try {
        const { name, phone, relationship } = req.body;
        if (!name || !phone) {
            return res.status(400).json({ success: false, message: 'Name and phone are required.' });
        }

        const contact = await TrustedContact.findOneAndUpdate(
            { userId: req.userId },
            {
                name:         name.trim(),
                phone:        phone.trim(),
                relationship: (relationship || '').trim(),
                updatedAt:    new Date()
            },
            { upsert: true, new: true }
        );

        res.json({ success: true, message: 'Trusted contact saved.', contact });
    } catch (err) {
        console.error('[TrustedContact] Save error:', err);
        res.status(500).json({ success: false, message: 'Could not save trusted contact.' });
    }
});

// DELETE /api/safety-tools/trusted-contact
router.delete('/trusted-contact', async (req, res) => {
    try {
        await TrustedContact.findOneAndDelete({ userId: req.userId });
        res.json({ success: true, message: 'Trusted contact removed.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Could not remove trusted contact.' });
    }
});

// POST /api/safety-tools/trusted-contact/log-alert
router.post('/trusted-contact/log-alert', async (req, res) => {
    try {
        await TrustedContact.findOneAndUpdate(
            { userId: req.userId },
            { lastAlertSentAt: new Date() }
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

module.exports = router;
