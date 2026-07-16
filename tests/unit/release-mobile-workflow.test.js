import { readFileSync } from 'node:fs';
import path from 'node:path';

const workflowPath = path.join(process.cwd(), '.github/workflows/release-mobile.yml');
const workflow = readFileSync(workflowPath, 'utf8');
const androidStart = workflow.indexOf('\n  android:');
const iosStart = workflow.indexOf('\n  ios:', androidStart);
const androidJob = workflow.slice(androidStart, iosStart);

describe('mobile release workflow contract', () => {
  it('publishes one dual-provider Android release instead of profile-specific APKs', () => {
    expect(androidStart).toBeGreaterThan(-1);
    expect(iosStart).toBeGreaterThan(androidStart);
    expect(androidJob).toContain('ANDROID_PUSH_PROVIDER: both');
    expect(androidJob).not.toContain('matrix.profile');
    expect(androidJob).not.toContain('profile: [play, fdroid]');
    expect(androidJob).toContain('forwardemail-mail_${VERSION}_android.apk');
    expect(androidJob).toContain('forwardemail-mail_${VERSION}_android.aab');
    expect(androidJob).not.toContain('android-play');
    expect(androidJob).not.toContain('android-fdroid');
  });

  it('fails before toolchain setup when dual-provider release inputs are missing', () => {
    const preflight = androidJob.indexOf('Preflight Android release configuration');
    const toolchain = androidJob.indexOf('Install Rust stable');

    expect(preflight).toBeGreaterThan(-1);
    expect(toolchain).toBeGreaterThan(preflight);
    expect(androidJob).toContain('GOOGLE_SERVICES_JSON_BASE64');
    expect(androidJob).toContain('VAPID_PUBLIC_KEY');
  });
});
