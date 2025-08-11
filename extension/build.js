#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import archiver from 'archiver';

const BUILD_DIR = 'build';
const DIST_DIR = 'dist';

// Create build and dist directories
[BUILD_DIR, DIST_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  }
});

// Copy files to build directory
const filesToCopy = ['manifest.json', 'content.js'];
filesToCopy.forEach(file => {
  fs.copyFileSync(file, path.join(BUILD_DIR, file));
});

// Update manifest version if provided
const version = process.env.VERSION;
if (version) {
  const manifestPath = path.join(BUILD_DIR, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.version = version;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

// Create zip file
const output = fs.createWriteStream(path.join(DIST_DIR, `extension-${version || 'latest'}.zip`));
const archive = archiver('zip', { zlib: { level: 9 } });

archive.pipe(output);
archive.directory(BUILD_DIR, false);
archive.finalize();

console.log('Extension package created successfully!');
