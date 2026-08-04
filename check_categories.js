const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/humrah');
  const collection = mongoose.connection.collection('foundermessages');
  const categories = await collection.distinct('category');
  console.log('Categories found:', categories);
  process.exit(0);
}

run();
