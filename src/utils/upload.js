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

// أنواع وأحجام الملفات المسموحة لرفع الوسائط (صور القصص وتسجيلاتها)
const MEDIA_RULES = {
  image: {
    maxBytes: 5 * 1024 * 1024,
    mimes: /^image\/(jpeg|png|webp|gif|heic|heif)$/i,
    exts: /\.(jpe?g|png|webp|gif|heic|heif)$/i,
    label: 'الصورة (JPG/PNG/WEBP حتى 5MB)',
  },
  audio: {
    maxBytes: 15 * 1024 * 1024,
    mimes: /^audio\/(mpeg|mp3|mp4|m4a|x-m4a|aac|wav|x-wav|wave|ogg|webm|3gpp)$/i,
    exts: /\.(mp3|m4a|aac|wav|ogg|webm|3gp)$/i,
    label: 'التسجيل الصوتي (MP3/M4A/WAV حتى 15MB)',
  },
};

class UploadError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}

/**
 * رفع ملفات وسائط بأسماء حقول محددة مع التحقق من النوع والحجم.
 * fields: { image: 'image' | 'audio', audio: 'audio' } (اسم الحقل ← نوعه)
 */
function makeMediaUpload(fields) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MEDIA_RULES.audio.maxBytes, files: Object.keys(fields).length },
    fileFilter: (_req, file, cb) => {
      const rule = MEDIA_RULES[fields[file.fieldname]];
      if (!rule) return cb(new UploadError('حقل ملف غير متوقع'));
      const ok = rule.mimes.test(file.mimetype || '') || rule.exts.test(file.originalname || '');
      return ok ? cb(null, true) : cb(new UploadError(`نوع الملف غير مدعوم: ${rule.label}`));
    },
  }).fields(Object.keys(fields).map((name) => ({ name, maxCount: 1 })));

  return (req, res, next) =>
    upload(req, res, (error) => {
      if (error) {
        const message =
          error.code === 'LIMIT_FILE_SIZE' ? 'حجم الملف كبير جدًا' : error.message || 'تعذر رفع الملف';
        return res.status(400).json({ message });
      }
      for (const [name, kind] of Object.entries(fields)) {
        const file = req.files?.[name]?.[0];
        if (file && file.size > MEDIA_RULES[kind].maxBytes) {
          return res.status(400).json({ message: `حجم الملف كبير جدًا: ${MEDIA_RULES[kind].label}` });
        }
      }
      return next();
    });
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
  makeMediaUpload,
  MEDIA_RULES,
  isCloudinaryConfigured,
  isAudio,
  makeUpload,
  fileUrl,
  uploadToCloudinary,
};