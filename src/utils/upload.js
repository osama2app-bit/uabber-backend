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

function isCloudinaryConfigured() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET
  );
}

/**
 * بدون Cloudinary (تطوير/اختبار فقط): حفظ الملف في مجلد uploads المحلي.
 * في الإنتاج تُستخدم Cloudinary دائمًا.
 */
async function saveLocally(req, folder, file) {
  const fs = require('fs/promises');
  const path = require('path');
  const crypto = require('crypto');
  const ext = (path.extname(file.originalname || '') || '').toLowerCase().replace(/[^.a-z0-9]/g, '');
  const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  const dir = path.join(__dirname, '..', '..', 'uploads', folder);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), file.buffer);
  return `${req.protocol}://${req.get('host')}/uploads/${folder}/${name}`;
}

async function fileUrl(req, folder, file) {
  if (!file) return null;
  if (!isCloudinaryConfigured() && process.env.NODE_ENV !== 'production') {
    return saveLocally(req, folder, file);
  }
  return uploadToCloudinary(file, folder);
}

module.exports = {
  isCloudinaryConfigured,
  isAudio,
  makeUpload,
  fileUrl,
  uploadToCloudinary,
};