/**
 * Contracts for the release-pipeline hardening of 2026-09-13. Each rule here
 * closes a way a red run could still ship or a secret could leak; see
 * docs/release-readiness.md ("Pipeline hardening completed").
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const readWorkflow = (name) => readFileSync(path.join(root, '.github', 'workflows', name), 'utf8');

const releaseWorkflow = readWorkflow('release.yml');
const desktopWorkflow = readWorkflow('release-desktop.yml');
const mobileWorkflow = readWorkflow('release-mobile.yml');
const ciWorkflow = readWorkflow('ci.yml');
const deployWorkflow = readWorkflow('deploy.yml');

const jobBlock = (workflow, jobName) => {
  const start = workflow.indexOf(`\n  ${jobName}:\n`);
  expect(start).toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
};

describe('release gating contracts', () => {
  it('deploys the web app only when every release gate succeeded', () => {
    const deploy = jobBlock(releaseWorkflow, 'deploy');
    expect(deploy).toContain(
      'needs: [create-release, e2e-webview, ci-gate, build-desktop, publish]',
    );
    expect(deploy).toContain("needs.e2e-webview.result == 'success'");
    expect(deploy).toContain("needs.ci-gate.result == 'success'");
    expect(deploy).toContain("needs.build-desktop.result == 'success'");
    // A skipped publish is still fine (np may have published first) but only
    // once the gates above have passed.
    expect(deploy).toContain("needs.publish.result == 'skipped'");
  });

  it('promotes the release from the orchestrator only, after mobile assets and checksums', () => {
    const publishRelease = jobBlock(desktopWorkflow, 'publish-release');
    expect(publishRelease).toContain("inputs.release_id == ''");
    const publish = jobBlock(releaseWorkflow, 'publish');
    expect(publish).toContain('needs: [create-release, build-desktop, build-mobile, checksums]');
  });

  it('runs the release CI gate with the non-mutating unit script', () => {
    const gate = jobBlock(releaseWorkflow, 'ci-gate');
    expect(gate).toContain('run: pnpm test:unit');
    expect(gate).not.toContain('pnpm test --');
  });

  it('imports the Windows certificate into the runner store and fails closed on demand', () => {
    expect(desktopWorkflow).toContain('- name: Import Windows code-signing certificate');
    expect(desktopWorkflow).toContain('Import-PfxCertificate');
    expect(desktopWorkflow).toContain('$conf.bundle.windows.certificateThumbprint = $thumbprint');
    expect(desktopWorkflow).toContain("$env:WINDOWS_SIGNING_REQUIRED -eq 'true'");
    // tauri-action never read these; passing them there only looked like signing.
    const buildStep = desktopWorkflow.slice(
      desktopWorkflow.indexOf('- name: Build and release Tauri app'),
      desktopWorkflow.indexOf('- name: Build Snap package'),
    );
    expect(buildStep).not.toContain('WINDOWS_CERTIFICATE: ${{ secrets.WINDOWS_CERTIFICATE }}');
  });

  it('does not hand the signing secrets to workflows that reference none', () => {
    // Match the YAML key on its own line; the explanatory comments in those
    // jobs mention the phrase and must not satisfy or fail this check.
    const inheritLine = /^ {4}secrets: inherit\s*$/m;
    for (const job of ['e2e-webview', 'release-screenshots']) {
      expect(jobBlock(releaseWorkflow, job)).not.toMatch(inheritLine);
    }
    expect(jobBlock(desktopWorkflow, 'e2e-webview-gate')).not.toMatch(inheritLine);
    // The builds still need the signing set, so the rule is targeted, not blanket.
    expect(jobBlock(releaseWorkflow, 'build-desktop')).toMatch(inheritLine);
  });

  it('keeps secrets and untrusted text out of rendered commands', () => {
    expect(mobileWorkflow).not.toContain('echo "${{ secrets.ANDROID_KEYSTORE_BASE64 }}"');
    expect(mobileWorkflow).toContain('printf \'%s\' "$ANDROID_KEYSTORE_BASE64" | base64 -d');
    expect(ciWorkflow).toContain('const body = process.env.CLEAR_WARNING;');
    expect(ciWorkflow).not.toContain(
      'const body = `${{ steps.clear_check.outputs.clear_warning }}`;',
    );
  });

  it('binds the Worker to whatever bucket the assets were synced to', () => {
    for (const workflow of [releaseWorkflow, deployWorkflow]) {
      expect(workflow).not.toContain('myselfhosted-webmail-test-1');
      expect(workflow).toContain(
        'sed -i -E "s/^bucket_name = \\".*\\"/bucket_name = \\"${R2_BUCKET}\\"/"',
      );
      expect(workflow).toContain('R2_BUCKET variable is not set');
    }
  });
});

describe('release asset upload resilience', () => {
  const uploadAction = readFileSync(
    path.join(root, '.github', 'actions', 'upload-release-asset', 'action.yml'),
    'utf8',
  );
  const buildDesktopWorkflow = readWorkflow('build-desktop.yml');

  it('lets tauri-action retry builds and uploads inside the job', () => {
    // v0.6.2 is the first pinned release with `retryAttempts`. GitHub's upload
    // endpoint failed three rows of v0.13.9 with transient 5xx responses.
    expect(desktopWorkflow).toMatch(
      /tauri-apps\/tauri-action@84b9d35b5fc46c1e45415bdb6144030364f7ebc5 # v0\.6\.2/,
    );
    expect(buildDesktopWorkflow).toMatch(
      /tauri-apps\/tauri-action@84b9d35b5fc46c1e45415bdb6144030364f7ebc5 # v0\.6\.2/,
    );
    expect(jobBlock(desktopWorkflow, 'build-and-release')).toContain('retryAttempts: 3');
  });

  it('routes every first-party asset upload through the retrying action', () => {
    for (const [name, workflow] of [
      ['release-desktop.yml', desktopWorkflow],
      ['release-mobile.yml', mobileWorkflow],
    ]) {
      expect(workflow, `${name} still uploads directly`).not.toContain('uploads.github.com');
      expect(workflow).toContain('uses: ./.github/actions/upload-release-asset');
    }
    // Snap, APK, AAB, Google-free APK, IPA, checksums.
    const uses = [desktopWorkflow, mobileWorkflow, releaseWorkflow]
      .join('\n')
      .match(/uses: \.\/\.github\/actions\/upload-release-asset/g);
    expect(uses).toHaveLength(6);
    // The only remaining direct upload is the draft-to-published migration
    // loop, which carries its own retry.
    const migration = jobBlock(releaseWorkflow, 'publish');
    expect(migration).toContain('uploads.github.com');
    expect(migration).toContain('for attempt in 1 2 3 4 5');
  });

  it('retries with backoff, clobbers partial assets, and verifies the size', () => {
    expect(uploadAction).toContain("default: '5'");
    expect(uploadAction).toContain('delete_existing');
    expect(uploadAction).toContain('sleep $(( attempt * attempt * 5 ))');
    expect(uploadAction).toContain('[ "$remote" = "$size" ]');
    expect(uploadAction).toContain('&& verify; then');
  });
});

describe('latest release promotion', () => {
  it('publishes first and marks Latest in a separate call', () => {
    // make_latest sent on the PATCH that flips draft=false is silently
    // dropped (GitHub validates it against the draft), which is how v0.14.0
    // through v0.14.4 all published without becoming Latest.
    const publish = jobBlock(releaseWorkflow, 'publish');
    expect(publish).not.toContain('-f draft=false -f make_latest=true');
    expect(publish).toContain('releases/${RELEASE_ID}" -f draft=false');
    expect(publish).toContain('releases/${TARGET_ID}" -f make_latest=true');
    // Both branches feed the same make_latest call.
    expect(publish).toContain('TARGET_ID="$OTHER_PUBLISHED"');
    expect(publish).toContain('TARGET_ID="$RELEASE_ID"');
  });

  it('does not report publish as done until releases/latest reflects the tag', () => {
    const publish = jobBlock(releaseWorkflow, 'publish');
    expect(publish).toContain("releases/latest\" --jq '.tag_name'");
    expect(publish).toContain('if [ "$latest" = "$TAG" ]; then');
    expect(publish).toContain('after marking it latest');
    expect(publish).toContain('exit 1');
  });

  it('repairs Latest from the summary before failing a green run', () => {
    const summary = jobBlock(releaseWorkflow, 'release-summary');
    expect(summary).toContain('- name: Verify the release is published and Latest');
    expect(summary).toContain("releases/tags/${TAG}\" --jq '.draft'");
    expect(summary).toContain("releases/latest\" --jq '.tag_name'");
    // Self-heal covers the np-published path, where the publish job is skipped.
    expect(summary).toContain('releases/${release_id}" -f make_latest=true');
    expect(summary).toContain('even after marking it latest');
  });
});
