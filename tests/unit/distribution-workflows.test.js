import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const readWorkflow = (name) => readFileSync(path.join(root, '.github', 'workflows', name), 'utf8');

const snapRecipe = readFileSync(path.join(root, 'snap', 'snapcraft.yaml'), 'utf8');

const releaseWorkflow = readWorkflow('release.yml');
const desktopWorkflow = readWorkflow('release-desktop.yml');
const fdroidWorkflow = readWorkflow('publish-fdroid-repo.yml');
const homebrewWorkflow = readWorkflow('publish-homebrew-tap.yml');

describe('distribution workflow contracts', () => {
  it('keeps Snap artifacts and Store publication on the native Linux release rows', () => {
    expect(desktopWorkflow).toContain('snapcore/action-build@v1');
    expect(desktopWorkflow).toContain('snapcore/action-publish@v1');
    expect(desktopWorkflow).toContain("vars.PUBLISH_SNAP_STORE == 'true'");
    expect(desktopWorkflow).toContain('SNAPCRAFT_STORE_CREDENTIALS');
    expect(desktopWorkflow).toContain('aarch64-unknown-linux-gnu');
    expect(desktopWorkflow).toContain('Upload Snap package to release');
  });

  it('builds the Snap from the repository root with updater artifacts disabled', () => {
    // snapcraft copies the job's working tree into an isolated build instance
    // that receives none of the job's secrets. Two things follow, and both have
    // already broken a release once:
    //
    //   1. The action must run from the repository root. Pointing it at snap/
    //      mounts only that directory and the part's source resolves to an
    //      empty tree.
    //   2. An earlier step in the same job rewrites tauri.conf.json to enable
    //      updater artifacts. Those need TAURI_SIGNING_PRIVATE_KEY, so the
    //      recipe has to turn the flag back off or the bundler aborts after the
    //      full Rust build has already run.
    const enableUpdaterStep = desktopWorkflow.indexOf('conf.bundle.createUpdaterArtifacts = true');
    const snapBuildStep = desktopWorkflow.indexOf('snapcore/action-build@v1');
    expect(enableUpdaterStep).toBeGreaterThan(-1);
    expect(snapBuildStep).toBeGreaterThan(enableUpdaterStep);

    expect(desktopWorkflow).not.toContain('path: snap');
    expect(snapRecipe).toMatch(/^\s*source: \.$/m);
    expect(snapRecipe).toContain('"createUpdaterArtifacts":false');
  });

  it('publishes the F-Droid index only after the Google-free release APK exists', () => {
    const fdroidCallerStart = releaseWorkflow.indexOf('  publish-fdroid-repository:');
    const homebrewCallerStart = releaseWorkflow.indexOf(
      '  publish-homebrew-tap:',
      fdroidCallerStart,
    );
    const fdroidCaller = releaseWorkflow.slice(fdroidCallerStart, homebrewCallerStart);

    expect(fdroidCallerStart).toBeGreaterThan(-1);
    expect(homebrewCallerStart).toBeGreaterThan(fdroidCallerStart);
    expect(fdroidCaller).toContain("vars.PUBLISH_FDROID_REPOSITORY == 'true'");
    // Reusable workflows cannot elevate permissions beyond their caller.
    expect(fdroidCaller).toMatch(/permissions:[\s\S]*pages: write[\s\S]*id-token: write/);
    expect(fdroidWorkflow).toContain('forwardemail-mail_*_fdroid.apk');
    expect(fdroidWorkflow).toContain('FDROID_KEYSTORE_BASE64');
    expect(fdroidWorkflow).toContain('FDROID_KEYSTORE_PASSWORD');
    expect(fdroidWorkflow).toContain('fdroid/public');
    expect(fdroidWorkflow).toContain('fingerprint.txt');
    expect(fdroidWorkflow).toContain('actions/configure-pages@v5');
    expect(fdroidWorkflow).toContain('needs: build');
    expect(fdroidWorkflow).toContain('name: github-pages');
    expect(fdroidWorkflow).toContain('actions/deploy-pages@v4');
  });

  it('keeps the Homebrew updater opt-in and targeted at the protected release environment', () => {
    expect(releaseWorkflow).toContain('publish-homebrew-tap:');
    expect(releaseWorkflow).toContain("vars.PUBLISH_HOMEBREW_TAP == 'true'");
    expect(homebrewWorkflow).toContain('environment: release');
    expect(homebrewWorkflow).toContain('HOMEBREW_TAP_TOKEN');
    expect(homebrewWorkflow).toContain('HOMEBREW_TAP_REPOSITORY');
    expect(homebrewWorkflow).toContain('sha256sum');
    expect(homebrewWorkflow).toContain('Casks/forward-email.rb');
    expect(homebrewWorkflow).toContain('peter-evans/create-pull-request@v7');
  });
});
