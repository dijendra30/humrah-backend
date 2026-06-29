const lettersService = require('../services/letters.service');
const reportService = require('../services/report.service');
const analyticsService = require('../services/analytics.service');
const lettersRepo = require('../repositories/letters.repository');
const repliesRepo = require('../repositories/replies.repository');
const reactionsRepo = require('../repositories/reactions.repository');
const reportsRepo = require('../repositories/reports.repository');

class LettersController {

  async createLetter(req, res) {
    try {
      const { body, category, feeling } = req.body;
      const userId = req.userId;

      // Check daily limit (5 per day)
      const startOfDay = new Date();
      startOfDay.setUTCHours(0, 0, 0, 0);
      const count = await lettersRepo.countUserLettersToday(userId, startOfDay);
      if (count >= 5) {
        return res.status(429).json({ success: false, message: 'You have reached the limit of 5 letters per day.' });
      }

      // Check letter creation cooldown (10 seconds)
      const latestLetter = await lettersRepo.getLatestUserLetter(userId);
      if (latestLetter && (Date.now() - new Date(latestLetter.createdAt).getTime() < 10000)) {
        return res.status(429).json({ success: false, message: 'Please wait a few seconds before writing another letter.' });
      }

      const letter = await lettersService.createLetter(userId, { body, category, feeling });

      // Trigger socket event
      const io = req.app.get('io');
      if (io) {
        io.emit('letter_created', { letterId: letter._id });
      }

      return res.status(201).json({
        success: true,
        message: 'Letter delivered.',
        letterId: letter._id
      });
    } catch (error) {
      console.error('Error in createLetter:', error);
      return res.status(500).json({ success: false, message: 'Failed to create letter' });
    }
  }

  async getFeed(req, res) {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;
      const category = req.query.category || null;
      const search = req.query.search || req.query.q || null;
      const sort = req.query.sort || 'new';

      const feed = await lettersService.getFeed(page, limit, category, search, sort);

      console.log("Letters found:", feed.letters.length);
      console.log(feed.letters);

      return res.status(200).json({
        success: true,
        ...feed
      });
    } catch (error) {
      console.error('Error in getFeed:', error);
      return res.status(500).json({ success: false, message: 'Failed to fetch letters' });
    }
  }

  async getLetterById(req, res) {
    try {
      const { id } = req.params;
      const data = await lettersService.getLetterDetails(id);
      
      if (!data) {
        return res.status(404).json({ success: false, message: 'Letter not found or has been removed' });
      }

      return res.status(200).json({
        success: true,
        ...data
      });
    } catch (error) {
      console.error('Error in getLetterById:', error);
      return res.status(500).json({ success: false, message: 'Failed to fetch letter details' });
    }
  }

  async createReply(req, res) {
    try {
      const { id } = req.params;
      const { body } = req.body;
      const userId = req.userId;

      // Check daily limit (20 per day)
      const startOfDay = new Date();
      startOfDay.setUTCHours(0, 0, 0, 0);
      const count = await repliesRepo.countUserRepliesToday(userId, startOfDay);
      if (count >= 20) {
        return res.status(429).json({ success: false, message: 'You have reached the limit of 20 replies per day.' });
      }

      // Check reply cooldown (3 seconds)
      const latestReply = await repliesRepo.getLatestUserReply(userId);
      if (latestReply && (Date.now() - new Date(latestReply.createdAt).getTime() < 3000)) {
        return res.status(429).json({ success: false, message: 'Please wait a few seconds before sending another note.' });
      }

      const letter = await lettersRepo.findById(id);
      if (!letter || letter.status !== 'active') {
        return res.status(404).json({ success: false, message: 'Letter not found or no longer active' });
      }

      const reply = await lettersService.createReply(userId, id, body);

      // Trigger socket event
      const io = req.app.get('io');
      if (io) {
        io.emit('letter_replied', { letterId: id, replyId: reply.id });
      }

      return res.status(201).json({
        success: true,
        message: 'Reply attached to letter.',
        reply
      });
    } catch (error) {
      console.error('Error in createReply:', error);
      return res.status(500).json({ success: false, message: 'Failed to reply to letter' });
    }
  }

  async reactToLetter(req, res) {
    try {
      const { id } = req.params;
      const { type } = req.body;
      const userId = req.userId;

      if (!['helped', 'warmth'].includes(type)) {
        return res.status(400).json({ success: false, message: 'Invalid reaction type' });
      }

      // Check daily limit (50 per day)
      const startOfDay = new Date();
      startOfDay.setUTCHours(0, 0, 0, 0);
      const count = await reactionsRepo.countUserReactionsToday(userId, startOfDay);
      if (count >= 50) {
        return res.status(429).json({ success: false, message: 'You have reached the limit of 50 reactions per day.' });
      }

      const result = await lettersService.toggleReaction(userId, id, type);

      return res.status(200).json({
        success: true,
        message: result.added ? `Reaction added` : `Reaction removed`,
        result
      });
    } catch (error) {
      console.error('Error in reactToLetter:', error);
      return res.status(500).json({ success: false, message: 'Failed to react to letter' });
    }
  }

  async unreactToLetter(req, res) {
    // We handle toggle in reactToLetter, but if a specific delete route is called:
    try {
      const { id } = req.params;
      const userId = req.userId;
      
      const existing = await reactionsRepo.findByUserAndLetter(userId, id);
      if (existing) {
        await reactionsRepo.delete(userId, id);
        const statField = existing.type === 'helped' ? 'comfortCount' : 'supportCount';
        await lettersRepo.incrementStat(id, statField, -1);
      }
      
      return res.status(200).json({ success: true, message: 'Reaction removed' });
    } catch (error) {
      console.error('Error in unreactToLetter:', error);
      return res.status(500).json({ success: false, message: 'Failed to unreact to letter' });
    }
  }

  async reportLetter(req, res) {
    try {
      const { id } = req.params;
      const { reason, customReason } = req.body;
      const userId = req.userId;

      // Check daily limit (10 per day)
      const startOfDay = new Date();
      startOfDay.setUTCHours(0, 0, 0, 0);
      const count = await reportsRepo.countUserReportsToday(userId, startOfDay);
      if (count >= 10) {
        return res.status(429).json({ success: false, message: 'You have reached the limit of 10 reports per day.' });
      }

      await reportService.reportLetter(userId, id, reason, customReason);

      // Trigger socket event
      const io = req.app.get('io');
      if (io) {
        io.emit('report_submitted', { letterId: id });
      }

      return res.status(200).json({
        success: true,
        message: 'Report submitted. The Humrah Safety Team will review this letter.'
      });
    } catch (error) {
      if (error.code === 11000 || error.message === 'DuplicateReport') {
        return res.status(400).json({ success: false, message: 'You have already reported this letter.' });
      }
      console.error('Error in reportLetter:', error);
      return res.status(500).json({ success: false, message: 'Failed to submit report' });
    }
  }

  // Admin routes
  async getStats(req, res) {
    try {
      // Typically only for admins. Admin check should be in middleware, but we can do a quick check here if needed.
      const stats = await analyticsService.generateDailyAnalytics();
      return res.status(200).json({ success: true, stats });
    } catch (error) {
      console.error('Error in getStats:', error);
      return res.status(500).json({ success: false, message: 'Failed to fetch stats' });
    }
  }
}

module.exports = new LettersController();
