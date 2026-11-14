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

// صيغ صوتية لا تعمل على iPhone (أو بعض أجهزة Android): نحوّلها إلى mp3.
const UNSAFE_AUDIO = /(ogg|opus|webm|amr|3gpp|3gp|x-ms-wma|wma|flac)/i;

function isAudio(file) {
  return Boolean(file?.mimetype?.startsWith('audio/'))
    || /\.(ogg|opus|webm|amr|3gp|wma|flac|m4a|mp3|aac|wav)$/i.test(file?.originalname || '');
}

function uploadToCloudinary(file, folder = 'uabber') {
  return new Promise((resolve, reject) => {
    if (!file) return resolve(null);

    const options = {
      folder: `uabber/${folder}`,
      resource_type: 'auto',
    };
    if (isAudio(file)) {
      options.resource_type = 'video'; // Cloudinary يعامل الصوت كـ video
      if (UNSAFE_AUDIO.test(`${file.mimetype} ${file.originalname || ''}`)) {
        options.format = 'mp3';
      }
    }

    const stream = cloudinary.uploader.upload_stream(
      options,
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
  isAudio,
  makeUpload,
  fileUrl,
  uploadToCloudinary,
};