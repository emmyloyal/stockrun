// Try the photo count on a real picture (no chain, nothing attested):
//   npm run count -- path/to/photo.jpg "Indomie noodles carton (40 x 70g)" carton [ordered]
// Needs GEMINI_API_KEY (in ../.env or the environment).
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { GeminiPhotoCounter, decideCount, type MediaType } from './check/photoCount.ts';

const envFile = new URL('../../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);
const [file, item = 'Indomie noodles carton (40 x 70g)', unit = 'carton', ordered] = process.argv.slice(2);
if (!file) { console.log('Usage: npm run count -- <photo.jpg|png|webp> ["item"] [unit]'); process.exit(1); }
if (!process.env.GEMINI_API_KEY) { console.log('Set GEMINI_API_KEY in .env first.'); process.exit(1); }

const types: Record<string, MediaType> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const mediaType = types[extname(file).toLowerCase()];
if (!mediaType) { console.log('Use a .jpg, .png or .webp photo.'); process.exit(1); }

const report = await new GeminiPhotoCounter().count({ data: readFileSync(file), mediaType }, { item, unit });
console.log('Gemini saw:', report);
console.log(`Decision${ordered ? ` (order of ${ordered})` : ''}:`, decideCount(report, ordered ? Number(ordered) : undefined));
