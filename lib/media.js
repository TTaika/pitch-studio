// Imported footage: probe it, and make a light 720p proxy + thumbnail so the browser
// preview scrubs smoothly and plays any codec (phone HEVC .mov included). Renders
// always use the original file.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const FFMPEG = require('ffmpeg-static');
const FFPROBE = require('@ffprobe-installer/ffprobe').path;

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|flac)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|svg)$/i;

function run(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(bin)} failed: ${(stderr || err.message).trim().split('\n').slice(-3).join(' ')}`));
      else resolve(stdout);
    });
  });
}

async function probe(file) {
  const out = JSON.parse(await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]));
  const v = out.streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const a = out.streams.find((s) => s.codec_type === 'audio');
  const [num, den] = (v?.avg_frame_rate || '0/1').split('/').map(Number);
  return {
    duration: Math.round(Number(out.format.duration || v?.duration || 0) * 1000) / 1000,
    width: v?.width || null,
    height: v?.height || null,
    fps: den ? Math.round((num / den) * 100) / 100 : null,
    codec: v?.codec_name || null,
    hasAudio: !!a,
  };
}

function kindOf(name) {
  if (VIDEO_EXT.test(name)) return 'video';
  if (AUDIO_EXT.test(name)) return 'audio';
  if (IMAGE_EXT.test(name)) return 'image';
  return null;
}

// Safe, unique file name inside dir.
function uniqueName(dir, original) {
  const ext = path.extname(original).toLowerCase();
  const base = path.basename(original, path.extname(original)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'clip';
  let name = base + ext, n = 2;
  while (fs.existsSync(path.join(dir, name))) name = `${base}-${n++}${ext}`;
  return name;
}

function proxyPath(mediaDir, name) { return path.join(mediaDir, '.proxy', name.replace(/\.[^.]+$/, '.mp4')); }
function thumbPath(mediaDir, name) { return path.join(mediaDir, '.thumbs', name.replace(/\.[^.]+$/, '.jpg')); }

// Proxy: 720p H.264 with a keyframe every half second, so seeking is instant.
async function makeProxy(mediaDir, name, info) {
  const src = path.join(mediaDir, name);
  const out = proxyPath(mediaDir, name);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const args = ['-v', 'error', '-y', '-i', src, '-vf', 'scale=-2:min(720\\,ih)', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-g', '15', '-pix_fmt', 'yuv420p'];
  args.push(...(info.hasAudio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']), '-movflags', '+faststart', out);
  await run(FFMPEG, args);
}

async function makeThumb(mediaDir, name, info) {
  const out = thumbPath(mediaDir, name);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const at = Math.min(1, (info.duration || 0) / 3);
  await run(FFMPEG, ['-v', 'error', '-y', '-ss', String(at), '-i', path.join(mediaDir, name), '-frames:v', '1', '-vf', 'scale=320:-2', out]);
}

// Full import pipeline for one file already saved in mediaDir.
async function processMedia(mediaDir, name) {
  const kind = kindOf(name);
  if (kind === 'image') return { kind, status: 'ready' };
  const info = await probe(path.join(mediaDir, name));
  if (kind === 'video') {
    await makeThumb(mediaDir, name, info);
    await makeProxy(mediaDir, name, info);
  }
  return { kind, status: 'ready', ...info };
}

module.exports = { probe, kindOf, uniqueName, processMedia, proxyPath, thumbPath, FFMPEG, FFPROBE };
