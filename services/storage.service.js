const path = require("path");
const fs = require("fs/promises");
const { cloudinary } = require("../config/cloudinary");

const saveFile = async (file) => {
  if (!file) return null;
  if (process.env.USE_CLOUDINARY === "true") {
    const uploaded = await cloudinary.uploader.upload(file.path, { folder: "gymza" });
    return uploaded.secure_url;
  }
  const uploadDir = path.join(process.cwd(), "uploads");
  await fs.mkdir(uploadDir, { recursive: true });
  const target = path.join(uploadDir, file.originalname);
  await fs.copyFile(file.path, target);
  return target;
};

module.exports = { saveFile };
