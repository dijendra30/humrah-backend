const crypto = require('crypto');
const lettersRepo = require('../repositories/letters.repository');
const repliesRepo = require('../repositories/replies.repository');
const reactionsRepo = require('../repositories/reactions.repository');
const moderationService = require('./moderation.service');
const { generateLocationLabel } = require('../utils/locationLabelGenerator');
const LetterNotification = require('../models/LetterNotification');

class LettersService {
  
  _generateAuthorHash(userId) {
    const secret = process.env.AUTHOR_SECRET || 'fallback_secret_humrah_letters';
    return crypto.createHash('sha256').update(userId.toString() + secret).digest('hex');
  }

  async createLetter(userId, { body, category, feeling }) {
    // Check limits (done in middleware or controller, but we can do it here if needed)
    
    // Moderation
    const modResult = moderationService.moderateText(body);
    
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24); // 24 hours
    
    // Detect Language
    const language = this._detectLanguage(body);

    const letterData = {
      author: userId,
      body,
      category,
      feeling,
      locationLabel: generateLocationLabel(),
      authorHash: this._generateAuthorHash(userId),
      expiresAt,
      status: modResult.safe ? 'active' : 'under_review',
      isModerated: !modResult.safe,
      moderationReason: !modResult.safe ? modResult.reasons.join(',') : null,
      moderationPriority: modResult.priority || 'normal',
      language
    };

    return await lettersRepo.create(letterData);
  }

  async getFeed(page = 1, limit = 20, category = null, search = null, sortType = 'new') {
    const query = { status: 'active' };
    
    if (category) {
      query.category = category;
    }
    
    if (search) {
      query.$text = { $search: search };
      sortType = 'score';
    }
    
    let sort = sortType === 'popular' ? { comfortCount: -1, createdAt: -1 } : { createdAt: -1 };
    if (sortType === 'score') {
      sort = { score: { $meta: 'textScore' } };
    }
    
    const result = await lettersRepo.findWithPagination(query, page, limit, sort);
    
    // Anonymize before sending
    const anonymizedLetters = result.letters.map(letter => this._anonymizeLetter(letter));
    
    return {
      letters: anonymizedLetters,
      page: result.page,
      totalPages: result.totalPages
    };
  }

  async getLetterDetails(letterId) {
    const letter = await lettersRepo.findById(letterId);
    if (!letter || letter.status !== 'active') return null;
    
    // Increment view count
    await lettersRepo.incrementStat(letterId, 'viewsCount');
    
    const replies = await repliesRepo.findByLetterId(letterId);
    
    return {
      letter: this._anonymizeLetter(letter),
      replies: replies.map(r => this._anonymizeReply(r)),
      stats: {
        comfortCount: letter.comfortCount,
        supportCount: letter.supportCount,
        replyCount: letter.replyCount,
        viewsCount: letter.viewsCount
      }
    };
  }

  async createReply(userId, letterId, body) {
    const modResult = moderationService.moderateText(body);
    
    const replyData = {
      letterId,
      author: userId,
      body,
      isModerated: !modResult.safe,
      moderationReason: !modResult.safe ? modResult.reasons.join(',') : null
    };
    
    const reply = await repliesRepo.create(replyData);
    
    if (modResult.safe) {
      // Increment reply count and engagement score on the letter (reply = +3)
      await lettersRepo.incrementStat(letterId, 'replyCount', 1);
      await lettersRepo.incrementStat(letterId, 'engagementScore', 3);

      // ── Notify letter author about the new note (skip self-notes) ──
      try {
        const letter = await lettersRepo.findById(letterId);
        if (letter && letter.author.toString() !== userId.toString()) {
          await LetterNotification.findOneAndUpdate(
            { recipientId: letter.author, letterId, type: 'note' },
            {
              $inc:        { count: 1 },
              $set:        { isRead: false, preview: body.substring(0, 100) },
              $setOnInsert: { recipientId: letter.author, letterId, type: 'note' }
            },
            { upsert: true }
          );
        }
      } catch (notifErr) {
        // Non-fatal — notification failure must never block the reply response
        console.error('[letters.service] reply notification error:', notifErr.message);
      }
    }
    
    return this._anonymizeReply(reply);
  }

  async toggleReaction(userId, letterId, type) {
    // Check if exists
    const existing = await reactionsRepo.findByUserAndLetter(userId, letterId);
    
    if (existing) {
      if (existing.type === type) {
        // Same type, remove it
        await reactionsRepo.delete(userId, letterId);
        const statField = type === 'helped' ? 'comfortCount' : 'supportCount';
        await lettersRepo.incrementStat(letterId, statField, -1);
        await lettersRepo.incrementStat(letterId, 'engagementScore', -2); // Reaction = +2
        return { added: false, type };
      } else {
        // Different type, we ignore or switch? Let's assume they can only have one, so we switch
        await reactionsRepo.delete(userId, letterId);
        const oldStatField = existing.type === 'helped' ? 'comfortCount' : 'supportCount';
        await lettersRepo.incrementStat(letterId, oldStatField, -1);
        await lettersRepo.incrementStat(letterId, 'engagementScore', -2); // Removing old
        
        await reactionsRepo.create({ userId, letterId, type });
        const newStatField = type === 'helped' ? 'comfortCount' : 'supportCount';
        await lettersRepo.incrementStat(letterId, newStatField, 1);
        await lettersRepo.incrementStat(letterId, 'engagementScore', 2); // Adding new
        return { added: true, type };
      }
    } else {
      // Add new
      await reactionsRepo.create({ userId, letterId, type });
      const statField = type === 'helped' ? 'comfortCount' : 'supportCount';
      await lettersRepo.incrementStat(letterId, statField, 1);
      await lettersRepo.incrementStat(letterId, 'engagementScore', 2); // Adding new

      // ── Notify letter author (skip self-reactions) ──
      try {
        const letter = await lettersRepo.findById(letterId);
        if (letter && letter.author.toString() !== userId.toString()) {
          const notifType = type === 'helped' ? 'comfort' : 'warmth';
          await LetterNotification.findOneAndUpdate(
            { recipientId: letter.author, letterId, type: notifType },
            {
              $inc:        { count: 1 },
              $set:        { isRead: false },
              $setOnInsert: { recipientId: letter.author, letterId, type: notifType }
            },
            { upsert: true }
          );
        }
      } catch (notifErr) {
        console.error('[letters.service] reaction notification error:', notifErr.message);
      }

      return { added: true, type };
    }
  }

  _anonymizeLetter(letter) {
    return {
      id: letter._id,
      body: letter.body,
      category: letter.category,
      feeling: letter.feeling,
      locationLabel: letter.locationLabel,
      authorHash: letter.authorHash,
      comfortCount: letter.comfortCount,
      supportCount: letter.supportCount,
      replyCount: letter.replyCount,
      engagementScore: letter.engagementScore,
      language: letter.language,
      createdAt: letter.createdAt,
      expiresAt: letter.expiresAt
    };
  }
  
  _anonymizeReply(reply) {
    return {
      id: reply._id,
      letterId: reply.letterId,
      body: reply.body,
      createdAt: reply.createdAt
    };
  }

  _detectLanguage(text) {
    if (!text) return 'unknown';
    // Simplified detection based on character blocks
    const lowerText = text.toLowerCase();
    
    // Check Hindi (Devanagari)
    if (/[\u0900-\u097F]/.test(lowerText)) return 'hi';
    
    // Check Bengali
    if (/[\u0980-\u09FF]/.test(lowerText)) return 'bn';
    
    // Check Tamil
    if (/[\u0B80-\u0BFF]/.test(lowerText)) return 'ta';
    
    // Check Telugu
    if (/[\u0C00-\u0C7F]/.test(lowerText)) return 'te';
    
    // Check Malayalam
    if (/[\u0D00-\u0D7F]/.test(lowerText)) return 'ml';
    
    // Check English
    if (/[a-z]/.test(lowerText)) return 'en';
    
    return 'unknown';
  }
}

module.exports = new LettersService();
