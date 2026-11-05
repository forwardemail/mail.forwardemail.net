import { readFileSync } from 'node:fs';
import path from 'node:path';

const workflowPath = path.join(process.cwd(), '.github/workflows/release-mobile.yml');
const workflow = readFileSync(workflowPath, 'utf8');
const androidStart = workflow.indexOf('\n  android:');
const androidFdroidStart = workflow.indexOf('\n  android-fdroid:', androidStart);
const iosStart = workflow.indexOf('\n  ios:', androidFdroidStart);
const androidJob = workflow.slice(androidStart, androidFdroidStart);
const androidFdroidJob = workflow.slice(androidFdroidStart, iosStart);
const iosJob = workflow.slice(iosStart);

describe('mobile release workflow contract', () => {
  it('publishes one dual-provider Android release without profile matrices', () => {
    expect(androidStart).toBeGreaterThan(-1);
    expect(androidFdroidStart).toBeGreaterThan(androidStart);
    expect(iosStart).toBeGreaterThan(androidFdroidStart);
    expect(androidJob).toContain('ANDROID_PUSH_PROVIDER: both');
    expect(androidJob).not.toContain('matrix.profile');
    expect(androidJob).not.toContain('profile: [play, fdroid]');
    expect(androidJob).toContain('forwardemail-mail_${VERSION}_android.apk');
    expect(androidJob).toContain('forwardemail-mail_${VERSION}_android.aab');
    expect(androidJob).not.toContain('android-play');
    expect(androidJob).not.toContain('android-fdroid');
  });

  it('publishes a separately signed Google-free UnifiedPush APK for F-Droid and Obtainium', () => {
    expect(androidFdroidStart).toBeGreaterThan(-1);
    expect(androidFdroidJob).toContain('Build signed UnifiedPush-only Android APK');
    expect(androidFdroidJob).toContain('pnpm tauri:android:build:fdroid');
    expect(androidFdroidJob).toContain('forwardemail-mail_${VERSION}_fdroid.apk');
    expect(androidFdroidJob).toContain('ANDROID_KEYSTORE_BASE64');
    expect(androidFdroidJob).toContain('VAPID_PUBLIC_KEY');
    expect(androidFdroidJob).not.toContain('GOOGLE_SERVICES_JSON_BASE64');
  });

  it('fails before toolchain setup when dual-provider release inputs are missing', () => {
    const preflight = androidJob.indexOf('Preflight Android release configuration');
    const toolchain = androidJob.indexOf('Install Rust stable');

    expect(preflight).toBeGreaterThan(-1);
    expect(toolchain).toBeGreaterThan(preflight);
    expect(androidJob).toContain('GOOGLE_SERVICES_JSON_BASE64');
    expect(androidJob).toContain('VAPID_PUBLIC_KEY');
  });

  it('saves the iOS dSYMs, since the archived app binary is stripped', () => {
    const build = iosJob.indexOf('pnpm tauri ios build');
    const upload = iosJob.indexOf('- name: Upload iOS dSYMs');
    expect(build).toBeGreaterThan(-1);
    expect(upload).toBeGreaterThan(build);
    const step = iosJob.slice(upload, iosJob.indexOf('\n\n', upload));
    expect(step).toContain('uses: actions/upload-artifact@');
    expect(step).toContain(
      'path: src-tauri/gen/apple/build/forwardemail-desktop_iOS.xcarchive/dSYMs',
    );
    // A diagnostics artifact that is missing must not fail the release.
    expect(step).toContain('if-no-files-found: warn');
    expect(step).toContain('retention-days: 90');
  });

  it('keeps Symbols/ when repacking the re-signed IPA', () => {
    expect(iosJob).not.toContain('zip -qry -X "$REPACK" Payload)');
    expect(iosJob).toContain('if [ -d "$WORK/Symbols" ]; then CONTENTS+=(Symbols); fi');
    expect(iosJob).toContain('zip -qry -X "$REPACK" "${CONTENTS[@]}"');
  });

  it('stops the release when the built app lacks the scene delegate', () => {
    const start = iosJob.indexOf('- name: Verify scene delegate (built IPA)');
    expect(start).toBeGreaterThan(iosJob.indexOf('- name: Rename IPA with version'));
    expect(start).toBeLessThan(iosJob.indexOf('- name: Attest iOS build provenance'));
    const step = iosJob.slice(start, iosJob.indexOf('\n      - name:', start));
    expect(step).toContain(
      'UIApplicationSceneManifest:UISceneConfigurations:UIWindowSceneSessionRoleApplication:0:UISceneDelegateClassName',
    );
    expect(step).toContain('xcrun otool -v -s __TEXT __objc_classname');
    expect(step).toContain('for CLASS in TaoSceneDelegate TaoWindowCapture; do');
    expect(step).toContain('exit 1');
  });
});
