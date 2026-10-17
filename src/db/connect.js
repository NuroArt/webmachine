'use strict';

const mongoose = require('mongoose');
const config = require('../config');
const logger = require('../utils/logger');

mongoose.set('strictQuery', true);

async function connectDb() {
  mongoose.connection.on('connected', () => logger.info('MongoDB connected'));
  mongoose.connection.on('error', (err) => logger.error({ err: err.message }, 'MongoDB error'));
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));

  await mongoose.connect(config.mongoUri, {
    serverSelectionTimeoutMS: 10000,
    maxPoolSize: 20,
    minPoolSize: 2,
    retryWrites: true,
  });

  return mongoose.connection;
}

async function disconnectDb() {
  await mongoose.connection.close(false);
}

module.exports = { connectDb, disconnectDb, mongoose };
