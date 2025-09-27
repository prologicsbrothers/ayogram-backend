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

  try {
    let uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 3600 }); // 1 hour

    // ✅ Replace internal R2 hostname → public .r2.dev URL
    if (process.env.R2_PUBLIC_DOMAIN) {
      const internalHost = `${process.env.R2_BUCKET}.${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
      uploadUrl = uploadUrl.replace(internalHost, process.env.R2_PUBLIC_DOMAIN.replace(/^https?:\/\//, ''));
      uploadUrl = `https://${uploadUrl}`; // prepend https://
    }

    // ✅ Debug log
    console.log("🔑 Env + Upload Debug:", {
      R2_BUCKET: process.env.R2_BUCKET,
      R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID,
      R2_PUBLIC_DOMAIN: process.env.R2_PUBLIC_DOMAIN,
      generatedKey: key,
      presignedUrl: uploadUrl
    });

    res.json({ uploadUrl, key });
  } catch (err) {
    console.error("❌ Presign upload error:", err);
    res.status(500).json({ error: 'Failed to generate presigned URL' });
  }
});

// ✅ Presign download
app.get('/presign-get', verifyToken, async (req, res) => {
  const { key } = req.query;
  if (!key) return res.status(400).json({ error: 'missing key' });

  const cmd = new GetObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key
  });

  try {
    let url = await getSignedUrl(s3, cmd, { expiresIn: 900 }); // 15 min

    if (process.env.R2_PUBLIC_DOMAIN) {
      const internalHost = `${process.env.R2_BUCKET}.${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
      url = url.replace(internalHost, process.env.R2_PUBLIC_DOMAIN.replace(/^https?:\/\//, ''));
      url = `https://${url}`;
    }

    res.json({ url });
  } catch (err) {
    console.error("❌ Presign download error:", err);
    res.status(500).json({ error: 'Failed to generate presigned download URL' });
  }
});

// ✅ Start server
const port = process.env.PORT || 8080;
app.listen(port, () => console.log('✅ Server running on port', port));
