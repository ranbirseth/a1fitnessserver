const mongoose = require("mongoose");

const getMongoUri = () => process.env.MONGO_URI || process.env.MONGO_URL || "mongodb://127.0.0.1:27017/gymza";

const connectDb = async () => {
  const mongoUri = getMongoUri();

  try {
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000,
      retryWrites: true,
      maxPoolSize: 10
    });

    console.log("MongoDB connected");
    return true;
  } catch (error) {
    console.warn("MongoDB connection unavailable. Continuing in development mode without a database.", error.message);
    return false;
  }
};

const isDbConnected = () => mongoose.connection.readyState === 1;

module.exports = { connectDb, isDbConnected, getMongoUri };
