// Builds the release binary, then copies the ONNX Runtime's DirectML.dll (which `ort` places next to the exe) into
// src-tauri/resources so the installer ships it. Run through `pnpm bundle`.
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
execSync('cargo build --release -p harvester', { cwd: root, stdio: 'inherit' });
const dll = join(root, 'target', 'release', 'DirectML.dll');
if (!existsSync(dll)) {
  console.error('DirectML.dll was not produced next to the release exe: the installer would not run the ML models.');
  process.exit(1);
}
const out = join(root, 'src-tauri', 'resources');
mkdirSync(out, { recursive: true });
copyFileSync(realpathSync(dll), join(out, 'DirectML.dll'));
console.log('copied DirectML.dll to', out);
