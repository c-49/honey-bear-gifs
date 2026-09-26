import 'dotenv/config';

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const originalsRoot = path.join(root, 'originals');
const config = JSON.parse(await readFile(path.join(root, 'gifs.config.json'), 'utf8'));
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const force = args.has('--force');
const prune = args.has('--prune');
const supportedExtensions = new Set(['.gif', '.webp', '.png', '.jpg', '.jpeg']);
const contentTypes = {
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg'
};

if (!Array.isArray(config.sizes) || config.sizes.length === 0 || !config.default || !config.maxBytes) {
  throw new Error('gifs.config.json must define sizes, default, and maxBytes.');
}

const sourceFiles = [];
for (const categoryEntry of (await readdir(originalsRoot, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!categoryEntry.isDirectory()) continue;
  const categoryPath = path.join(originalsRoot, categoryEntry.name);
  const files = (await readdir(categoryPath, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const fileEntry of files) {
    if (!fileEntry.isFile() || !supportedExtensions.has(path.extname(fileEntry.name).toLowerCase())) continue;
    const sourcePath = path.join(categoryPath, fileEntry.name);
    const bytes = await readFile(sourcePath);
    const id = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    sourceFiles.push({
      category: categoryEntry.name,
      filename: fileEntry.name,
      sourcePath,
      bytes,
      id
    });
  }
}

if (sourceFiles.length === 0) throw new Error(`No supported image files found under ${originalsRoot}.`);

const plannedFiles = sourceFiles.map((file) => {
  const sizes = Object.fromEntries(config.sizes.map(({ w, h }) => {
    const size = `${w}x${h}`;
    return [size, `r/${size}/${file.category}/${file.id}.gif`];
  }));
  return {
    ...file,
    sizes,
    originalKey: `originals/${file.category}/${file.filename}`
  };
});

if (dryRun) {
  console.log(`DRY RUN: ${plannedFiles.length} original files; no credentials or uploads required.`);
  for (const file of plannedFiles) {
    console.log(`originals/${file.category}/${file.filename}`);
    for (const [size, key] of Object.entries(file.sizes)) console.log(`  ${size}: ${key}`);
  }
  console.log(`Would upload ${plannedFiles.length} originals and ${plannedFiles.length * config.sizes.length} resized files, plus manifest.json.`);
  if (prune) console.log('--prune is skipped during dry-run; remote objects were not inspected.');
  process.exit(0);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

const accountId = requiredEnv('R2_ACCOUNT_ID');
const bucket = requiredEnv('R2_BUCKET');
const s3 = new S3Client({
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  region: 'auto',
  forcePathStyle: true,
  credentials: {
    accessKeyId: requiredEnv('R2_ACCESS_KEY_ID'),
    secretAccessKey: requiredEnv('R2_SECRET_ACCESS_KEY')
  }
});

async function objectExists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (error) {
    if (error.name === 'NotFound' || error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) return false;
    throw error;
  }
}

async function upload(key, body, contentType, cacheControl) {
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: cacheControl
  }));
}

async function resizeGif(bytes, width, height) {
  const variants = [
    { effort: 7 },
    { effort: 7, colours: 128, dither: 0.5 },
    { effort: 7, colours: 64, dither: 0.5 }
  ];
  let output;
  for (const gifOptions of variants) {
    output = await sharp(bytes, { animated: true })
      .resize(width, height, { fit: 'inside', withoutEnlargement: true })
      .gif(gifOptions)
      .toBuffer();
    if (output.byteLength <= config.maxBytes) return output;
  }
  throw new Error(`Resized GIF is ${output.byteLength} bytes, over the ${config.maxBytes}-byte limit.`);
}

const manifest = {
  version: new Date().toISOString(),
  default: config.default,
  categories: {}
};
const referencedKeys = new Set();

for (const file of plannedFiles) {
  const category = manifest.categories[file.category] ??= [];
  category.push({ id: file.id, name: file.filename, sizes: file.sizes });

  if (force || !(await objectExists(file.originalKey))) {
    await upload(file.originalKey, file.bytes, contentTypes[path.extname(file.filename).toLowerCase()], 'public, max-age=60');
    console.log(`Uploaded ${file.originalKey}`);
  }

  for (const { w, h } of config.sizes) {
    const size = `${w}x${h}`;
    const key = file.sizes[size];
    referencedKeys.add(key);
    if (!force && await objectExists(key)) {
      console.log(`Exists ${key}`);
      continue;
    }
    const resized = await resizeGif(file.bytes, w, h);
    await upload(key, resized, 'image/gif', 'public, max-age=31536000, immutable');
    console.log(`Uploaded ${key} (${resized.byteLength} bytes)`);
  }
}

const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
await upload('manifest.json', manifestBytes, 'application/json', 'public, max-age=60');
console.log(`Uploaded manifest.json (${plannedFiles.length} entries across ${Object.keys(manifest.categories).length} categories).`);

if (prune) {
  let continuationToken;
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: 'r/',
      ContinuationToken: continuationToken
    }));
    for (const object of page.Contents ?? []) {
      if (object.Key && !referencedKeys.has(object.Key)) {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }));
        console.log(`Pruned ${object.Key}`);
      }
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
}