class AiProvider {
  /**
   * Extract JSON profile from user text
   * @param {string} userText - The text provided by the user
   * @returns {Promise<Object>} - The extracted JSON profile
   */
  async extractProfile(userText) {
    throw new Error('extractProfile must be implemented by the provider');
  }
}

module.exports = AiProvider;
