require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const admin = require('firebase-admin');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// ✅ Firebase Admin init
admin.initializeApp({
  credential: admin.credential.cert(require(process.env.FIREBASE_ADMIN_SDK_JSON))
});

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '20mb' }));

// ✅ R2 client
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  },
  forcePathStyle: false
});

// ✅ Generate safe object key
function makeObjectKey({ channelKey, originalName }) {
  const safeName = originalName
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_\-\.]/g, '');
  return `chat_media/${channelKey}/${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}_${safeName}`;
}

// ✅ Middleware: Firebase ID Token Verify
async function verifyToken(req, res, next) {
  const idToken =
    req.headers.authorization?.split('Bearer ')[1] || req.body.idToken;
  if (!idToken) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.uid = decoded.uid;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ✅ Ping endpoint (for warmup)
app.get('/ping', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ✅ Presign upload
app.post('/presign-upload', verifyToken, async (req, res) => {
  const { fileName, contentType, channelKey } = req.body;
  if (!fileName || !contentType || !channelKey)
    return res.status(400).send({ error: 'missing' });

  const key = makeObjectKey({ channelKey, originalName: fileName });
  const cmd = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    ContentType: contentType
  });

  let uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 3600 }); // 1 hr

  // ✅ Debug log
  console.log("🔑 Env + Upload Debug:", {
    R2_BUCKET: process.env.R2_BUCKET,
    R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID,
    R2_PUBLIC_DOMAIN: process.env.R2_PUBLIC_DOMAIN,
    generatedKey: key,
    presignedUrl: uploadUrl
  });

  // // ✅ Replace internal R2 hostname → public .r2.dev URL
  // uploadUrl = uploadUrl.replace(
  //   `${process.env.R2_BUCKET}.${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  //   process.env.R2_PUBLIC_DOMAIN // 👈 Render/Env me set karo: pub-xxxxx.r2.dev
  // );

  res.json({ uploadUrl, key });
});

// ✅ Presign download
app.get('/presign-get', verifyToken, async (req, res) => {
  const { key } = req.query;
  if (!key) return res.status(400).json({ error: 'missing key' });

  const cmd = new GetObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key
  });

  let url = await getSignedUrl(s3, cmd, { expiresIn: 900 }); // 15 min

  // ✅ Replace hostname → public URL
  url = url.replace(
    `${process.env.R2_BUCKET}.${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    process.env.R2_PUBLIC_DOMAIN
  );

  res.json({ url });
});

// ✅ Start server
const port = process.env.PORT || 8080;
app.listen(port, () => console.log('✅ Server running on port', port));
