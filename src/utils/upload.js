const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

function makeUpload(folder, fieldName) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 },
  }).single(fieldName);
}

function uploadToCloudinary(file, folder = 'uabber') {
  return new Promise((resolve, reject) => {
    if (!file) return resolve(null);

    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `uabber/${folder}`,
        resource_type: 'auto',
      },
      (error, result) => {
        if (error) return reject(error);
        return resolve(result.secure_url);
      }
    );

    stream.end(file.buffer);
  });
}

async function fileUrl(req, folder, file) {
  return uploadToCloudinary(file, folder);
}

module.exports = {
  makeUpload,
  fileUrl,
  uploadToCloudinary,
};