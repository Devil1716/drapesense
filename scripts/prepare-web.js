const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'www');
const files = [
  'index.html', 'style.css', 'app.js', 'version.js',
  'pattern-shirt.svg', 'pattern-kurta.svg', 'pattern-dress.svg', 'pattern-pants.svg'
];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const file of files) fs.copyFileSync(path.join(root, file), path.join(out, file));
if (fs.existsSync(path.join(root, 'config.js'))) {
  fs.copyFileSync(path.join(root, 'config.js'), path.join(out, 'config.js'));
}
console.log(`Prepared ${files.length + (fs.existsSync(path.join(root, 'config.js')) ? 1 : 0)} web files in www/`);
