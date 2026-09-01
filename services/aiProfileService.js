const groqProvider = require('./providers/groqProvider');
const geminiProvider = require('./providers/geminiProvider');

const SCHEMA_PROMPT = `
You are a strict data extraction assistant for Humrah, a social meetup app.
Your task is to extract profile information from the user's provided text.
You must return a valid JSON object matching the following schema.
If a field is not explicitly mentioned or clearly implied by the user's text, omit it or use an empty array.
If the text is an AI refusal (e.g. "I cannot help with that"), return an empty JSON object {}.

JSON Schema:
{
  "status": "complete",
  "profile_data": {
    "personality": ["array of strings"],
    "social_style": ["array of strings"],
    "interests": ["array of strings"],
    "hobbies": ["array of strings"],
    "comfort_activities": ["array of strings"],
    "relaxation_activities": ["array of strings"],
    "movie_preferences": {
      "liked": ["array of strings"],
      "disliked": ["array of strings"]
    },
    "music_preferences": {
      "liked": ["array of strings"],
      "disliked": ["array of strings"]
    },
    "food_preferences": ["array of strings"],
    "travel_preferences": ["array of strings"],
    "activity_preferences": ["array of strings"],
    "hangout_preferences": ["array of strings"],
    "good_meetup": ["array of strings"],
    "preferred_people": ["array of strings"],
    "other_preferences": ["array of strings"]
  },
  "profile_summary": "A friendly, authentic first-person bio. Summarize their text naturally."
}
`;

class AiProfileService {
  async extractProfile(userText) {
    let result = null;
    
    // Primary: Groq
    try {
      result = await groqProvider.extractProfile(userText, SCHEMA_PROMPT);
      if (result) return result;
    } catch (error) {
      console.warn('Groq extraction failed, falling back to Gemini:', error.message);
    }

    // Fallback: Gemini
    try {
      result = await geminiProvider.extractProfile(userText, SCHEMA_PROMPT);
      if (result) return result;
    } catch (error) {
      console.error('Gemini extraction failed as well:', error.message);
      throw new Error('AI profile extraction failed on all providers');
    }
    
    return {};
  }
}

module.exports = new AiProfileService();
