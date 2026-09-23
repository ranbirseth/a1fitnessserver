require("dotenv").config();
const mongoose = require("mongoose");
const Member = require("../models/member.model");

const generateUniqueSecretCode = async () => {
  let code;
  let exists = true;
  while (exists) {
    code = Math.floor(100 + Math.random() * 900).toString();
    const existing = await Member.findOne({ secretCode: code });
    if (!existing) exists = false;
  }
  return code;
};

const backfill = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB for backfilling secret codes...");

    const membersWithoutCode = await Member.find({ 
      $or: [
        { secretCode: { $exists: false } },
        { secretCode: null },
        { secretCode: "" }
      ]
    });

    console.log(`Found ${membersWithoutCode.length} members without a secret code.`);

    for (const member of membersWithoutCode) {
      const newCode = await generateUniqueSecretCode();
      member.secretCode = newCode;
      await member.save();
      console.log(`Updated member ${member._id} with code ${newCode}`);
    }

    console.log("Backfill completed successfully.");
    process.exit(0);
  } catch (error) {
    console.error("Backfill failed:", error);
    process.exit(1);
  }
};

backfill();
