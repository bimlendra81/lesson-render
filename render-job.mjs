// Renders one exported lesson (3D) to a silent MP4 with the same Remotion settings the worker uses.
// Runs on a remote machine (GitHub Actions) with Node 20 + @remotion/renderer 4.0.529. Narration is added later by finalize-job.mjs.
//
//   node render-job.mjs --job <dir> --out silent.mp4 [--bundle <dir>] [--frames 0-59] [--gl swangle] [--concurrency 2]
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: arg } = parseArgs({
  options: {
    job: { type: 'string' },
    out: { type: 'string' },
    bundle: { type: 'string' },
    frames: { type: 'string' },
    gl: { type: 'string', default: 'swangle' },
    concurrency: { type: 'string', default: '2' },
  },
});
if (!arg.job || !arg.out) throw new Error('usage: node render-job.mjs --job <dir> --out <file> [--bundle dir] [--frames a-b] [--gl mode] [--concurrency n]');

const CRF = 28;
const TIMEOUT_MS = 600_000;
const bundle = arg.bundle ?? join(arg.job, 'bundle');
const input = JSON.parse(await readFile(join(arg.job, 'input.json'), 'utf8'));
if (input.style === '2d') throw new Error('2D lessons need baked layers; only 3D lessons can be rendered here');

const exists = (p) => stat(p).then(() => true, () => false);

// Same opaque URL scheme as the worker's model file server: /m/<n>.vrm for models, /b/<file> for figures.
const files = new Map();
const models = {};
let n = 0;
for (const member of input.script.cast) {
  const path = join(arg.job, 'models', `${member.id}.vrm`);
  if (member.modelFile && (await exists(path))) {
    files.set(`/m/${n}.vrm`, path);
    models[member.id] = n;
    n += 1;
  }
}
// A scene names its figures as the older single `image` and/or the placed `images` list.
const sceneImages = (s) => [s.props?.image, ...(s.props?.images ?? []).map((im) => im.name)];
const imageNames = [...new Set(input.script.scenes.flatMap(sceneImages).filter(Boolean))];
const presentImages = [];
for (const name of imageNames) {
  const path = join(arg.job, 'images', name);
  if (await exists(path)) {
    files.set(`/b/${name}`, path);
    presentImages.push(name);
  }
}

const server = createServer((req, res) => {
  const file = req.method === 'GET' ? files.get(req.url ?? '') : undefined;
  if (!file) {
    res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
    res.end();
    return;
  }
  stat(file).then((info) => {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': file.endsWith('.png') ? 'image/png' : 'model/gltf-binary',
      'Content-Length': info.size,
    });
    createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

const inputProps = {
  script: input.script,
  audio: input.audio,
  models: Object.fromEntries(Object.entries(models).map(([id, i]) => [id, `http://127.0.0.1:${port}/m/${i}.vrm`])),
  ...(presentImages.length > 0 ? { images: { baseUrl: `http://127.0.0.1:${port}/b/` } } : {}),
};

const { ensureBrowser, renderMedia, selectComposition } = await import('@remotion/renderer');
await ensureBrowser();
const chromiumOptions = { gl: arg.gl };
const started = Date.now();
try {
  const composition = await selectComposition({ serveUrl: bundle, id: 'Lesson', inputProps, chromiumOptions, timeoutInMilliseconds: TIMEOUT_MS, logLevel: 'error' });
  let frameRange;
  if (arg.frames) {
    const [from, to] = arg.frames.split('-').map(Number);
    frameRange = [from, Math.min(to, composition.durationInFrames - 1)];
  }
  const total = frameRange ? frameRange[1] - frameRange[0] + 1 : composition.durationInFrames;
  console.log(`rendering ${total} frames (gl=${arg.gl}, concurrency=${arg.concurrency}, ${composition.width}x${composition.height} @ ${composition.fps}fps)`);
  let lastLog = 0;
  await renderMedia({
    composition,
    serveUrl: bundle,
    codec: 'h264',
    crf: CRF,
    muted: true,
    inputProps,
    outputLocation: arg.out,
    concurrency: Number(arg.concurrency),
    chromiumOptions,
    timeoutInMilliseconds: TIMEOUT_MS,
    logLevel: 'error',
    ...(frameRange ? { frameRange } : {}),
    onProgress: ({ renderedFrames }) => {
      if (Date.now() - lastLog < 15_000) return;
      lastLog = Date.now();
      const secs = (Date.now() - started) / 1000;
      console.log(`  ${renderedFrames}/${total} frames, ${(renderedFrames / secs).toFixed(1)} fps, eta ${Math.round((total - renderedFrames) / Math.max(renderedFrames / secs, 0.01) / 60)} min`);
    },
  });
  const secs = (Date.now() - started) / 1000;
  console.log(`RESULT gl=${arg.gl} frames=${total} seconds=${secs.toFixed(1)} fps=${(total / secs).toFixed(2)}`);
} finally {
  server.closeAllConnections();
  server.close();
}
