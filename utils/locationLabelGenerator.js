const LABELS = [
  "🌙 From someone awake tonight",
  "☕ From a café not too far away",
  "🌧️ From someone listening to the rain",
  "📚 From a quiet corner nearby",
  "🌆 From this city tonight",
  "✨ From someone with a wandering mind",
  "🌻 From a peaceful evening nearby",
  "🕯️ From someone carrying a thought"
];

function generateLocationLabel() {
  const randomIndex = Math.floor(Math.random() * LABELS.length);
  return LABELS[randomIndex];
}

module.exports = {
  generateLocationLabel
};
