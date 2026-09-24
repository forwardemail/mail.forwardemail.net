#!/usr/bin/env node
/**
 * Make the Android Gradle Plugin strip the Rust library and package its
 * debug symbols separately.
 *
 * Called after `tauri android init` regenerates gen/android/. The Rust
 * release profile keeps DWARF in the binary (see src-tauri/Cargo.toml), which
 * is roughly 39 MB per ABI on Android. Native libraries are stored
 * uncompressed inside an APK, and Play never strips them either, so without
 * this every Android user downloaded that debug data.
 *
 * Three edits are made to app/build.gradle.kts:
 *
 * 1. The generated debug build type contains
 *    `packaging { jniLibs.keepDebugSymbols.add("*\/arm64-v8a/*.so") ... }`.
 *    The Gradle `BuildType` DSL has no `packaging` member, so the Kotlin
 *    script resolves that block against the enclosing `android {}` scope and
 *    it applies to every build type. That is the actual reason release
 *    libraries were never stripped: AGP's strip task copies any library that
 *    matches a keepDebugSymbols glob straight through. The block is removed
 *    and the same globs are re-applied to debug variants only through the
 *    variant API, which does scope them per build type.
 * 2. `ndkVersion` (or `ndkPath` when the NDK lives outside the SDK), so the
 *    NDK AGP uses for llvm-strip and llvm-objcopy is explicit rather than
 *    whatever default the plugin version happens to carry.
 * 3. `ndk { debugSymbolLevel = "FULL" }` on the release build type. AGP then
 *    strips the shipped .so files and writes the symbols to
 *    BUNDLE-METADATA/com.android.tools.build.debugsymbols/ in the AAB, which
 *    is the only place Play Console reads native symbols from. It also emits
 *    app/build/outputs/native-debug-symbols/<variant>/native-debug-symbols.zip
 *    for symbolicating crashes from the sideloaded APK.
 */

const fs = require('fs');
const path = require('path');

const genDir = path.resolve(__dirname, '..', 'src-tauri', 'gen', 'android');
const gradlePath = path.join(genDir, 'app', 'build.gradle.kts');

if (!fs.existsSync(gradlePath)) {
  console.error('build.gradle.kts not found. Run `tauri android init` first');
  process.exit(1);
}

let gradle = fs.readFileSync(gradlePath, 'utf8');

if (gradle.includes('debugSymbolLevel')) {
  console.log('Native symbol config already present in build.gradle.kts. Skipping');
  process.exit(0);
}

function readSdkDir() {
  const fromEnv = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (fromEnv) return fromEnv;
  const localProps = path.join(genDir, 'local.properties');
  if (!fs.existsSync(localProps)) return null;
  const match = fs.readFileSync(localProps, 'utf8').match(/^sdk\.dir=(.+)$/m);
  return match ? match[1].trim() : null;
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// Resolve the NDK the same way scripts/android-build.sh and CI do: an explicit
// NDK env var first, then the newest NDK installed under the SDK.
function resolveNdk() {
  const sdkDir = readSdkDir();
  const sdkNdkDir = sdkDir ? path.join(sdkDir, 'ndk') : null;
  const explicit = process.env.ANDROID_NDK_HOME || process.env.NDK_HOME;

  if (explicit && fs.existsSync(explicit)) {
    const resolved = path.resolve(explicit);
    if (sdkNdkDir && path.dirname(resolved) === path.resolve(sdkNdkDir)) {
      return { version: path.basename(resolved) };
    }
    return { ndkPath: resolved };
  }

  if (sdkNdkDir && fs.existsSync(sdkNdkDir)) {
    const versions = fs
      .readdirSync(sdkNdkDir)
      .filter((name) => /^\d+(\.\d+)*$/.test(name))
      .sort(compareVersions);
    if (versions.length > 0) return { version: versions[versions.length - 1] };
  }

  return null;
}

const ndk = resolveNdk();
if (!ndk) {
  console.warn(
    'No Android NDK found (ANDROID_NDK_HOME, NDK_HOME, or <sdk>/ndk). ' +
      'AGP will fall back to its bundled default NDK version, which may need a download.',
  );
} else {
  const line = ndk.version
    ? `    ndkVersion = "${ndk.version}"`
    : `    ndkPath = ${JSON.stringify(ndk.ndkPath)}`;
  const namespaceLine = gradle.match(/^\s*namespace = .*$/m);
  if (!namespaceLine) {
    console.error('Could not find `namespace` inside the android block of build.gradle.kts');
    process.exit(1);
  }
  gradle = gradle.replace(namespaceLine[0], `${namespaceLine[0]}\n${line}`);
}

// Lift the misplaced keepDebugSymbols block out of the debug build type. It
// is module scoped there, which disables stripping for release as well.
const keepBlock = /\n[ \t]*packaging\s*\{\s*jniLibs\.keepDebugSymbols[^}]*\}/;
const keepMatch = gradle.match(keepBlock);
const keepGlobs = keepMatch
  ? Array.from(keepMatch[0].matchAll(/keepDebugSymbols\.add\("([^"]+)"\)/g), (m) => m[1])
  : [];
if (keepMatch) {
  gradle = gradle.replace(keepBlock, '');
}

const releaseBlock = /getByName\("release"\)\s*\{/;
if (!releaseBlock.test(gradle)) {
  console.error('Could not find the release buildType in build.gradle.kts');
  process.exit(1);
}
gradle = gradle.replace(
  releaseBlock,
  'getByName("release") {\n' +
    '            // Strip the Rust library and ship its symbols out of band.\n' +
    '            ndk {\n' +
    '                debugSymbolLevel = "FULL"\n' +
    '            }',
);

if (keepGlobs.length > 0) {
  const globList = keepGlobs.map((g) => JSON.stringify(g)).join(', ');
  gradle +=
    '\n// Keep native debug symbols in debug builds only. The generated project\n' +
    '// declared these in the debug build type, but that DSL has no packaging\n' +
    '// scope, so they leaked to every build type and blocked release stripping.\n' +
    'androidComponents {\n' +
    '    onVariants(selector().withBuildType("debug")) { variant ->\n' +
    `        variant.packaging.jniLibs.keepDebugSymbols.addAll(listOf(${globList}))\n` +
    '    }\n' +
    '}\n';
}

fs.writeFileSync(gradlePath, gradle);
console.log(
  `Injected native symbol config into build.gradle.kts (${
    ndk ? (ndk.version ? `ndkVersion ${ndk.version}` : `ndkPath ${ndk.ndkPath}`) : 'no NDK pin'
  }; ${keepGlobs.length} keepDebugSymbols glob(s) scoped to debug)`,
);
