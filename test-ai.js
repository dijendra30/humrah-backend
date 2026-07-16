require('dotenv').config();
const { rephraseContent } = require('./services/broadcastAiService');

async function run() {
  try {
    const res = await rephraseContent({
      title: 'Weekend Meetup',
      message: 'Join us this weekend to meet new people, make friends, and enjoy a fun activity together. We hope to see you there.',
      tone: 'Professional',
      language: 'en'
    });
    console.log(res);
  } catch(e) {
    console.error(e.message);
  }
}
run();
