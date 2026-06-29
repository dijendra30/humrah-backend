const crypto = require('crypto');
const lettersRepo = require('../repositories/letters.repository');
const repliesRepo = require('../repositories/replies.repository');
const reactionsRepo = require('../repositories/reactions.repository');
const moderationService = require('./moderation.service');
const { generateLocationLabel } = require('../utils/locationLabelGenerator');
const notificationsService = require('./notifications.service');

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

  async getFeed(userId, page = 1, limit = 20, category = null, search = null, sortType = 'new') {
    const query = { status: 'active', expiresAt: { $gt: new Date() } };
    
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
    const anonymizedLetters = result.letters.map(letter => this._anonymizeLetter(letter, userId));
    
    return {
      letters: anonymizedLetters,
      page: result.page,
      totalPages: result.totalPages
    };
  }

  async getLetterDetails(userId, letterId) {
    const letter = await lettersRepo.findById(letterId);
    if (!letter || letter.status !== 'active') return null;
    
    // Increment view count
    await lettersRepo.incrementStat(letterId, 'viewsCount');
    
    const replies = await repliesRepo.findByLetterId(letterId);
    
    return {
      letter: this._anonymizeLetter(letter, userId),
      replies: replies.map(r => this._anonymizeReply(r, userId)),
      stats: {
        comfortCount: letter.comfortCount,
        supportCount: letter.supportCount,
        replyCount: letter.replyCount,
        viewsCount: letter.viewsCount
      }
    };
  }

  async createReply(userId, letterId, body) {
    const letter = await lettersRepo.findById(letterId);
    if (!letter) {
      throw new Error('LetterNotFound');
    }
    if (letter.author.toString() === userId.toString()) {
      throw new Error('SelfInteractionNotAllowed');
    }

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
      // Increment reply count and engagement score on the letter (reply = +4)
      await lettersRepo.incrementStat(letterId, 'replyCount', 1);
      await lettersRepo.incrementStat(letterId, 'engagementScore', 4);

      // Notify letter author about the new note
      await notificationsService.notifyNewNote(letter.author, letterId, body);
    }
    
    return this._anonymizeReply(reply, userId);
  }

  async toggleReaction(userId, letterId, type) {
    const letter = await lettersRepo.findById(letterId);
    if (!letter) {
      throw new Error('LetterNotFound');
    }
    if (letter.author.toString() === userId.toString()) {
      throw new Error('SelfInteractionNotAllowed');
    }

    // Check if exists
    const existing = await reactionsRepo.findByUserAndLetter(userId, letterId);
    
    if (existing) {
      if (existing.type === type) {
        // Same type, remove it
        await reactionsRepo.delete(userId, letterId);
        const statField = type === 'helped' ? 'comfortCount' : 'supportCount';
        const scoreChange = type === 'helped' ? -3 : -2;
        await lettersRepo.incrementStat(letterId, statField, -1);
        await lettersRepo.incrementStat(letterId, 'engagementScore', scoreChange);
        return { added: false, type };
      } else {
        // Different type, switch it
        await reactionsRepo.delete(userId, letterId);
        const oldStatField = existing.type === 'helped' ? 'comfortCount' : 'supportCount';
        const oldScoreChange = existing.type === 'helped' ? -3 : -2;
        await lettersRepo.incrementStat(letterId, oldStatField, -1);
        await lettersRepo.incrementStat(letterId, 'engagementScore', oldScoreChange);
        
        await reactionsRepo.create({ userId, letterId, type });
        const newStatField = type === 'helped' ? 'comfortCount' : 'supportCount';
        const newScoreChange = type === 'helped' ? 3 : 2;
        await lettersRepo.incrementStat(letterId, newStatField, 1);
        await lettersRepo.incrementStat(letterId, 'engagementScore', newScoreChange);
        return { added: true, type };
      }
    } else {
      // Add new
      await reactionsRepo.create({ userId, letterId, type });
      const statField = type === 'helped' ? 'comfortCount' : 'supportCount';
      const scoreChange = type === 'helped' ? 3 : 2;
      await lettersRepo.incrementStat(letterId, statField, 1);
      await lettersRepo.incrementStat(letterId, 'engagementScore', scoreChange);

      const notifType = type === 'helped' ? 'comfort' : 'warmth';
      await notificationsService.notifyNewReaction(letter.author, letterId, notifType);

      return { added: true, type };
    }
  }

  async getMyLetters(userId) {
    const letters = await lettersRepo.findMyLetters(userId);
    const now = new Date();
    
    const activeLetters = [];
    const archivedLetters = [];

    letters.forEach(letter => {
      const anonymized = this._anonymizeLetter(letter, userId);
      if (new Date(letter.expiresAt) > now) {
        activeLetters.push(anonymized);
      } else {
        archivedLetters.push(anonymized);
      }
    });

    return { activeLetters, archivedLetters };
  }

  _anonymizeLetter(letter, currentUserId) {
    const isMine = currentUserId && letter.author ? letter.author.toString() === currentUserId.toString() : false;

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
      expiresAt: letter.expiresAt,
      isMine: isMine
    };
  }
  
  _anonymizeReply(reply, currentUserId) {
    const isMine = currentUserId && reply.author ? reply.author.toString() === currentUserId.toString() : false;

    return {
      id: reply._id,
      letterId: reply.letterId,
      body: reply.isModerated ? '[This note was removed by moderation]' : reply.body,
      createdAt: reply.createdAt,
      isMine: isMine
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
