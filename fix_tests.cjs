const fs = require('fs');
let code = fs.readFileSync('test-core.js', 'utf8');

code = code.replace(/for \(const key in videoDownloadUrls\) \{\n    delete videoDownloadUrls\[key\];\n  \}/g, `videoDownloadUrls.clear();`);
code = code.replace(/Object\.keys\(videoDownloadUrls\)\.length/g, `videoDownloadUrls.size`);
code = code.replace(/videoDownloadUrls\[id\]/g, `videoDownloadUrls.get(id)`);

fs.writeFileSync('test-core.js', code);
console.log('Fixed test-core.js');
