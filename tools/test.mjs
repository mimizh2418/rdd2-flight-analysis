import { createRequire } from 'node:module';
import { existsSync, readdirSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);

/**
 * Load TypeScript locally, falling back to an explicitly configured or existing editor installation.
 *
 * @returns {object} TypeScript compiler API loaded from the first usable installation.
 * @throws {Error} If no compiler can be loaded; the message identifies dependency/configuration remedies.
 * @remarks Tries project dependencies, TYPESCRIPT_PATH, the system package, then editor installations.
 */
export function compiler() {
  try {
    return require('typescript');
  } catch {}
  const candidates = [process.env.TYPESCRIPT_PATH, '/usr/share/nodejs/typescript'];
  const vscode = join(process.env.HOME ?? '', '/.vscode-server/bin');
  if (existsSync(vscode)) {
    for (const d of readdirSync(vscode)) {
      candidates.push(join(vscode, d, 'extensions/node_modules/typescript'));
    }
  }
  for (const p of candidates.filter(Boolean)) {
    try {
      return require(p);
    } catch {}
  }
  throw new Error('Install dependencies, or set TYPESCRIPT_PATH to an installed TypeScript package.');
}

/**
 * Transpile viewer sources into the disposable test directory and rewrite relative JavaScript imports.
 *
 * @returns {string} Absolute .test-build output directory after transpiling src without type checking.
 * @throws {Error} If source transpilation reports syntax diagnostics or filesystem operations fail.
 * @remarks Preserves the src layout and adds .js to extensionless relative imports so Node can load the emitted
 *   modules.
 */
export function compile() {
  const ts = compiler();
  const out = resolve('.test-build');
  mkdirSync(out, { recursive: true });

  /**
   * Recursively transpile TypeScript and TSX source files while preserving their directory layout.
   *
   * @param {string} dir Source directory relative to the project working directory.
   * @returns {void} Writes emitted modules under the enclosing output directory; does not copy non-TypeScript assets.
   * @throws {Error} If reading, transpilation, or writing fails.
   */
  function walk(dir) {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, name.name);
      if (name.isDirectory()) {
        walk(file);
      } else if (/\.tsx?$/.test(file)) {
        const target = join(out, file.replace(/\.tsx?$/, '.js'));
        mkdirSync(dirname(target), { recursive: true });
        const result = ts.transpileModule(readFileSync(file, 'utf8'), {
          fileName: file,
          reportDiagnostics: true,
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
        });
        const errors = result.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error) ?? [];
        if (errors.length) {
          throw new Error(
            ts.formatDiagnosticsWithColorAndContext(errors, {
              /**
               * Keep diagnostic filenames in their original spelling.
               *
               * @param {string} f Filename supplied by TypeScript.
               * @returns {string} The unchanged filename.
               */
              getCanonicalFileName: (f) => f,

              /**
               * Supply the diagnostic formatter's working directory.
               *
               * @returns {string} Current process directory.
               */
              getCurrentDirectory: () => process.cwd(),

              /**
               * Use consistent line separators in formatted diagnostics.
               *
               * @returns {string} A single LF character.
               */
              getNewLine: () => '\n',
            }),
          );
        }
        writeFileSync(
          target,
          result.outputText.replace(
            /(from\s+['"]|import\s*\(\s*['"])(\.[^'"]+)(['"])/g,
            (_, a, p, c) => `${a}${/\.[a-z]+$/i.test(p) ? p : p + '.js'}${c}`,
          ),
        );
      }
    }
  }
  walk('src');
  return out;
}

/**
 * Discover core suites in a stable order, excluding fixtures and support modules.
 *
 * @param {string} directory Directory containing core test suites, relative to the project root.
 * @returns {string[]} Sorted paths of files ending in .test.mjs.
 * @throws {Error} If the directory cannot be read or contains no test suites.
 */
export function discoverTests(directory = 'tests/core') {
  const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map((entry) => join(directory, entry.name))
    .sort();

  if (!files.length) {
    throw new Error(`No core test suites found in ${directory}.`);
  }

  return files;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  compile();

  const result = spawnSync(process.execPath, ['--test', ...discoverTests()], { stdio: 'inherit' });

  process.exitCode = result.status ?? 1;
}
