const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');
const DEV_VERSION = '0.0.1-dev';

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/, '');
}

function shouldUseGitTagVersion() {
  return process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
}

// Get release version from CI/tag context. Local builds stay on DEV_VERSION.
function getVersion() {
  // 1. Check for VERSION environment variable (set by CI)
  if (process.env.VERSION) {
    const version = normalizeVersion(process.env.VERSION);
    console.log(`Using version from VERSION env: ${version}`);
    return version;
  }

  // 2. CI tag builds may run without VERSION in local workflow tests.
  // Local builds intentionally stay on the committed development version.
  if (shouldUseGitTagVersion()) {
    if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME) {
      const version = normalizeVersion(process.env.GITHUB_REF_NAME);
      console.log(`Using version from GitHub tag ref: ${version}`);
      return version;
    }

    try {
      const tag = execSync('git describe --tags --exact-match 2>/dev/null', {
        encoding: 'utf8',
        cwd: repoRoot
      }).trim();

      if (tag) {
        const version = normalizeVersion(tag);
        console.log(`Using version from exact git tag: ${version}`);
        return version;
      }
    } catch (e) {
      // No exact tag found, fall through to development version.
    }
  }

  // 3. Fallback: the repository's checked-in version is always dev.
  console.log(`Using development version: ${DEV_VERSION}`);
  return DEV_VERSION;
}

// Update package.json version
function updateJsonFile(filePath, update) {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const updated = update(parsed) || parsed;
  fs.writeFileSync(filePath, JSON.stringify(updated, null, 2) + '\n');
  return updated;
}

// Update package.json version
function updatePackageVersion(version, root = repoRoot) {
  const packagePath = path.join(root, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

  const oldVersion = packageJson.version;
  packageJson.version = version;

  fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n');

  console.log(`package.json version updated: ${oldVersion} -> ${version}`);
  return version;
}

function updateTauriVersion(version, root = repoRoot) {
  const tauriConfigPath = path.join(root, 'src-tauri', 'tauri.conf.json');
  if (!fs.existsSync(tauriConfigPath)) return false;
  const oldVersion = JSON.parse(fs.readFileSync(tauriConfigPath, 'utf8')).version;
  updateJsonFile(tauriConfigPath, (config) => {
    config.version = version;
    return config;
  });
  console.log(`tauri.conf.json version updated: ${oldVersion} -> ${version}`);
  return true;
}

function updateProjectVersion(version, root = repoRoot) {
  updatePackageVersion(version, root);
  updateTauriVersion(version, root);
  return version;
}

// Run build
function runBuild() {
  // In CI, only compile; packaging runs through Tauri separately.
  const command = process.env.CI ? 'pnpm run compile' : 'pnpm run build';
  console.log(`Running ${command}...\n`);
  execSync(command, {
    stdio: 'inherit',
    cwd: repoRoot
  });
}

function shouldSkipBuild() {
  return process.env.BAT_SKIP_BUILD === '1' || process.argv.includes('--skip-build');
}

function main() {
  const version = getVersion();
  console.log(`\nBuilding version: ${version}\n`);

  updateProjectVersion(version);
  if (shouldSkipBuild()) {
    console.log('Skipping compile/build because --skip-build or BAT_SKIP_BUILD=1 was set.');
  } else {
    runBuild();
  }

  console.log(`\nBuild completed: v${version}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEV_VERSION,
  getVersion,
  normalizeVersion,
  updatePackageVersion,
  updateTauriVersion,
  updateProjectVersion,
  runBuild,
  shouldSkipBuild,
  main,
};
