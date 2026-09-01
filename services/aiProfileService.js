const groqProvider = require('./providers/groqProvider');
const geminiProvider = require('./providers/geminiProvider');

const SCHEMA_PROMPT = `
You are a strict data extraction assistant for Humrah, a social meetup app.
Your task is to extract profile information from the user's provided text.
You must return a valid JSON object matching the following schema.
If a field is not explicitly mentioned or clearly implied by the user's text, omit it (do not include it in the JSON).
Do not invent facts, hobbies, or personality traits.
If the text is an AI refusal (e.g. "I cannot help with that"), return an empty JSON object {}.

JSON Schema:
{
  "bio": "A friendly, authentic 2-3 sentence bio describing the user. Summarize their text naturally.",
  "hobbies": ["array of strings (e.g. 'Photography', 'Reading')"],
  "interests": ["array of strings"],
  "comfortActivity": ["array of strings. ONLY allowed values: 'Watch movies/series', 'Read a book', 'Listen to music', 'Eat good food', 'Scroll social media', 'Sleep/Nap'"],
  "relaxActivity": ["array of strings. ONLY allowed values: 'Scroll social media', 'Watch YouTube/Netflix', 'Play games', 'Call a friend', 'Take a walk', 'Listen to podcasts', 'Do nothing, just chill'"],
  "musicPreference": ["array of strings. ONLY allowed values: 'Bollywood hits', 'English pop/rock', 'Indie/alternative', 'Hip-hop/rap', 'EDM/electronic', 'Classical/instrumental', 'Regional language music', 'I don't really listen to music'"],
  "socialActivities": ["array of strings (e.g. 'Going to cafes', 'Attending workshops')"],
  "conversationInterests": ["array of strings (e.g. 'Technology', 'Philosophy', 'Travel')"],
  "humrahRoomInterests": ["array of strings (e.g. 'Movies', 'Tech Discussions')"],
  "socialVibe": "A single sentence describing their social energy",
  "goodMeetupMeaning": "A short sentence describing what makes a good meetup for them",
  "vibeQuote": "A quote or motto they live by (only if explicitly stated)"
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
