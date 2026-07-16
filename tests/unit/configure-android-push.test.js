import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const sourceScript = join(process.cwd(), 'scripts', 'configure-android-push.cjs');
const fixtures = [];

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'forwardemail-android-push-'));
  fixtures.push(root);

  const scriptDir = join(root, 'scripts');
  const androidDir = join(root, 'src-tauri', 'gen', 'android');
  const appDir = join(androidDir, 'app');
  const manifestDir = join(appDir, 'src', 'main');

  mkdirSync(scriptDir, { recursive: true });
  mkdirSync(manifestDir, { recursive: true });
  mkdirSync(join(root, 'src-tauri', 'capabilities'), { recursive: true });
  cpSync(sourceScript, join(scriptDir, 'configure-android-push.cjs'));

  writeFileSync(
    join(androidDir, 'build.gradle.kts'),
    `buildscript {\n    dependencies {\n        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25")\n    }\n}\n`,
  );
  writeFileSync(
    join(appDir, 'build.gradle.kts'),
    `plugins {\n    id("com.android.application")\n}\n\ndependencies {\n}\n`,
  );
  writeFileSync(
    join(manifestDir, 'AndroidManifest.xml'),
    `<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n    <application android:label="Mail">\n    </application>\n</manifest>\n`,
  );

  return {
    root,
    androidDir,
    appDir,
    capabilityPath: join(root, 'src-tauri', 'capabilities', 'android-fcm.generated.json'),
    manifestPath: join(manifestDir, 'AndroidManifest.xml'),
    scriptPath: join(scriptDir, 'configure-android-push.cjs'),
  };
}

function configure(fixture, provider, extraEnv = {}) {
  return spawnSync(process.execPath, [fixture.scriptPath], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      ANDROID_PUSH_PROVIDER: provider,
      VAPID_PUBLIC_KEY: 'test-public-key',
      ...extraEnv,
    },
  });
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

describe('configure-android-push', () => {
  it('keeps a UnifiedPush build free of Firebase and Play Services wiring', () => {
    const fixture = createFixture();
    const result = configure(fixture, 'unified-push');

    expect(result.status, result.stderr).toBe(0);
    const projectGradle = readFileSync(join(fixture.androidDir, 'build.gradle.kts'), 'utf8');
    expect(projectGradle).toContain('kotlin-gradle-plugin:2.2.21');
    expect(projectGradle).not.toContain('kotlin-gradle-plugin:1.9.25');
    expect(result.stdout).toContain('Kotlin: 2.2.21');
    expect(projectGradle).not.toContain('com.google.gms');
    expect(readFileSync(join(fixture.appDir, 'build.gradle.kts'), 'utf8')).not.toContain(
      'com.google.firebase',
    );
    expect(readFileSync(fixture.manifestPath, 'utf8')).not.toContain('firebase');
    expect(existsSync(join(fixture.appDir, 'google-services.json'))).toBe(false);
    expect(existsSync(fixture.capabilityPath)).toBe(false);
  });

  it('preserves a generated Kotlin compiler that is already newer than the minimum', () => {
    const fixture = createFixture();
    const projectGradlePath = join(fixture.androidDir, 'build.gradle.kts');
    writeFileSync(
      projectGradlePath,
      readFileSync(projectGradlePath, 'utf8').replace(
        'kotlin-gradle-plugin:1.9.25',
        'kotlin-gradle-plugin:2.3.20',
      ),
    );

    const result = configure(fixture, 'unified-push');

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(projectGradlePath, 'utf8')).toContain('kotlin-gradle-plugin:2.3.20');
    expect(result.stdout).toContain('Kotlin: 2.3.20');
  });

  it('adds Firebase and the optional FCM capability only for dual-provider Play builds', () => {
    const fixture = createFixture();
    const googleServices = join(fixture.root, 'google-services.json');
    writeFileSync(googleServices, '{"project_info":{"project_id":"test"}}\n');

    const result = configure(fixture, 'both', {
      GOOGLE_SERVICES_JSON: googleServices,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(fixture.androidDir, 'build.gradle.kts'), 'utf8')).toContain(
      'com.google.gms:google-services:4.4.2',
    );
    expect(readFileSync(join(fixture.appDir, 'build.gradle.kts'), 'utf8')).toContain(
      'com.google.firebase:firebase-messaging',
    );
    expect(readFileSync(fixture.manifestPath, 'utf8')).toContain(
      'com.google.firebase.MESSAGING_EVENT',
    );
    expect(readFileSync(fixture.capabilityPath, 'utf8')).toContain('remote-push:default');
    expect(existsSync(join(fixture.appDir, 'google-services.json'))).toBe(true);
  });

  it('removes stale Firebase files and Gradle/manifest wiring when switching to UnifiedPush', () => {
    const fixture = createFixture();
    const googleServices = join(fixture.root, 'google-services.json');
    writeFileSync(googleServices, '{"project_info":{"project_id":"test"}}\n');

    const playResult = configure(fixture, 'both', {
      GOOGLE_SERVICES_JSON: googleServices,
    });
    expect(playResult.status, playResult.stderr).toBe(0);

    const unifiedPushResult = configure(fixture, 'unified-push');
    expect(unifiedPushResult.status, unifiedPushResult.stderr).toBe(0);

    expect(readFileSync(join(fixture.androidDir, 'build.gradle.kts'), 'utf8')).not.toContain(
      'com.google.gms',
    );
    expect(readFileSync(join(fixture.appDir, 'build.gradle.kts'), 'utf8')).not.toContain(
      'com.google.firebase',
    );
    expect(readFileSync(fixture.manifestPath, 'utf8')).not.toContain('firebase');
    expect(existsSync(join(fixture.appDir, 'google-services.json'))).toBe(false);
    expect(existsSync(fixture.capabilityPath)).toBe(false);
  });

  it('fails release configuration when the selected UnifiedPush profile lacks a VAPID key', () => {
    const fixture = createFixture();
    const result = configure(fixture, 'unified-push', {
      REQUIRE_PUSH_CONFIG: '1',
      VAPID_PUBLIC_KEY: '',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('VAPID_PUBLIC_KEY is not set');
  });
});
