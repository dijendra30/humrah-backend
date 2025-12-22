// middleware/security.js
const helmet = require('helmet');
const mongoSanitize = require('express-mongo-sanitize');
const hpp = require('hpp');

const setupSecurity = (app) => {
  // Helmet - Security headers
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https://res.cloudinary.com"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));

  // Sanitize data against NoSQL injection
  app.use(mongoSanitize());


  // Prevent HTTP Parameter Pollution
  app.use(hpp());

  // CORS configuration
  const corsOptions = {
    origin: process.env.NODE_ENV === 'production' 
      ? ['https://humrah.in', 'https://www.humrah.in']
      : ['http://localhost:3000', 'http://localhost:19006'],
    credentials: true,
    optionsSuccessStatus: 200,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  };

  const cors = require('cors');
  app.use(cors(corsOptions));
};

module.exports = setupSecurity;
