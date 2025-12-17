const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Generate version: 1.yy.mmddhhiiss
function generateVersion() {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const ii = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');

  return `1.${yy}.${mm}${dd}${hh}${ii}${ss}`;
}

// Update package.json version
function updatePackageVersion(version) {
  const packagePath = path.join(__dirname, '..', 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

  const oldVersion = packageJson.version;
  packageJson.version = version;

  fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n');

  console.log(`Version updated: ${oldVersion} -> ${version}`);
  return version;
}

// Run build
function runBuild() {
  console.log('Running build...\n');
  execSync('npm run build', {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..')
  });
}

// Main
const version = generateVersion();
console.log(`\nBuilding version: ${version}\n`);

updatePackageVersion(version);
runBuild();

console.log(`\nBuild completed: v${version}`);
