const path = require('path');
const multer = require('multer');
const fs = require('fs');

function makeUpload(folder, fieldName) {
  const dir = path.join(__dirname, '../../uploads', folder);
  fs.mkdirSync(dir, { recursive: true });
  const storage = multer.diskStorage({
    destination: (_, __, cb) => cb(null, dir),
    filename: (_, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    },
  });
  return multer({ storage, limits: { fileSize: 15 * 1024 * 1024 } }).single(fieldName);
}
function fileUrl(req, folder, file) {
  if (!file) return null;
  return `${process.env.BASE_URL || `${req.protocol}://${req.get('host')}`}/uploads/${folder}/${file.filename}`;
}
module.exports = { makeUpload, fileUrl };
