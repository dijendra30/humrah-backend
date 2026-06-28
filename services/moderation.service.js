class ModerationService {
  moderateText(text) {
    const reasons = [];
    let score = 0;
    const lowerText = text.toLowerCase();

    // Basic regex filters for simulated moderation
    
    // Personal Info / Contact
    const phoneRegex = /\b\d{10,14}\b/;
    const emailRegex = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
    const socialRegex = /(instagram\.com|insta|snapchat|snap|whatsapp|wa\.me|facebook\.com)/i;
    
    if (phoneRegex.test(lowerText)) { reasons.push('phone_number'); score += 5; }
    if (emailRegex.test(lowerText)) { reasons.push('email_address'); score += 5; }
    if (socialRegex.test(lowerText)) { reasons.push('social_link'); score += 5; }
    
    // Profanity/Abuse (simulated small list)
    const profanityRegex = /\b(fuck|shit|bitch|asshole|cunt)\b/i;
    if (profanityRegex.test(lowerText)) { reasons.push('profanity'); score += 10; }
    
    // High Priority Self-Harm
    const selfHarmRegex = /\b(kill myself|suicide|end my life|don't want to live|i want to die|no reason to live)\b/i;
    let priority = 'normal';
    
    if (selfHarmRegex.test(lowerText)) { 
      reasons.push('self_harm'); 
      score += 100; 
      priority = 'high';
    }
    
    // Hate/Threats
    const hateRegex = /\b(kill|murder|terror)\b/i;
    if (hateRegex.test(lowerText) && priority !== 'high') { reasons.push('hate_threat'); score += 20; }
    
    const isSafe = score < 10; // Threshold for automatic flagging
    
    return {
      safe: isSafe,
      score: score,
      reasons: reasons,
      priority: priority
    };
  }
}

module.exports = new ModerationService();
